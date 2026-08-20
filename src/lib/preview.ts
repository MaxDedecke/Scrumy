// Vorschau-Modus: startet das Frontend, das das Team im Projekt-Repo gebaut
// hat, als echten laufenden Prozess und macht ihn im Browser ansichtbar.
//
// Die Agenten sind frei in der Technologiewahl (siehe teamKickoff.ts), es gibt
// also keinen festen Build-Befehl. `detectFrontend` sucht deshalb heuristisch
// nach einem `package.json` mit einem `dev`/`start`/`preview`-Script oder,
// ohne Bundler, nach einer statischen `index.html`.
//
// Architektur: jede laufende Vorschau ist ein eigener, ressourcenbegrenzter
// Sibling-Container (docker/preview-runner.Dockerfile + preview-entrypoint.js),
// nicht ein Kindprozess dieses Prozesses. Gruende:
//  * Isolation – generierter Code (von der LLM geschrieben, potenziell
//    fehlerhaft oder aus einem kompromittierten npm-Paket) laeuft NICHT mit
//    denselben Rechten wie Scrumy selbst, sieht nicht dieselben Secrets
//    (eigenes, sehr kleines Environment statt geerbtem `process.env`) und
//    kommt netzwerkseitig nicht an db/worker heran (eigenes Docker-Netz
//    "scrumy_preview", siehe docker-compose.yml).
//  * Blast Radius – CPU/RAM/Prozesslimits pro Container; eine Endlosschleife
//    im generierten Code reisst nicht den ganzen App-Container mit.
//  * `npm install`/Build-Cache landen NIE im getrackten Git-Arbeitsverzeichnis
//    (Audit-Trail der Agenten), sondern nur in der Container-Sicht darauf.
//  * Ueberlebt einen Neustart von "app": der Container laeuft unabhaengig
//    weiter, `getPreviewInfo` liest den echten Zustand per `docker inspect`
//    statt einem In-Memory-Zustand zu vertrauen, der beim Neustart verloren
//    ginge. Das macht "app" nebenbei horizontal skalierbar (auf demselben
//    Docker-Host): jede Replica sieht denselben Docker-Daemon und dieselbe DB.
//
// Kein Pfad-Proxy fuers iframe: generierte Frontends verlinken Assets fast
// immer absolut ("/assets/…"), was unter einem Pfadpräfix bricht. Jede
// Vorschau bekommt stattdessen einen echten Port aus einem in
// docker-compose.yml veroeffentlichten Bereich (PREVIEW_PORT_RANGE_START..END),
// das iframe zeigt direkt auf `http://<host>:<port>/`.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import type { PreviewStatus } from "@/generated/prisma/client";

const execFileAsync = promisify(execFile);

const LOG_LINES = 40;

function dockerNetwork(): string {
  return process.env.PREVIEW_DOCKER_NETWORK || "scrumy_preview";
}
function workspaceVolume(): string {
  return process.env.PREVIEW_WORKSPACE_VOLUME || "scrumy_scrumy_workspaces";
}
function runnerImage(): string {
  return process.env.PREVIEW_RUNNER_IMAGE || "scrumy-preview-runner";
}
function portRange(): { start: number; end: number } {
  return {
    start: Number(process.env.PREVIEW_PORT_RANGE_START ?? 4100),
    end: Number(process.env.PREVIEW_PORT_RANGE_END ?? 4119),
  };
}

/// Ohne Shell (wie `git()` in workspace.ts): Projekt-IDs/Pfade duerfen
/// niemals als Shell-Code interpretiert werden.
async function docker(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 5 * 1024 * 1024,
    timeout: options.timeoutMs ?? 15_000,
  });
  return stdout;
}

/// Docker-Containernamen sind an die Projekt-ID gebunden – dieselbe Regel wie
/// `removeWorkspace` in workspace.ts, damit hier nie ein manipulierter Wert
/// zu einem beliebigen Containernamen wird.
function containerName(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`Ungültige Projekt-ID: ${projectId}`);
  return `scrumy-preview-${projectId}`;
}

// --- Frontend-Erkennung ------------------------------------------------------
// Läuft in DIESEM Prozess (liest direkt aus dem gemounteten Workspace-Volume,
// nicht im Vorschau-Container) – nur eine Erkennung, kein Schreibzugriff.

const FRONTEND_CANDIDATE_DIRS = [".", "frontend", "web", "client", "app", "ui"];
const STATIC_CANDIDATE_DIRS = [".", "public", "dist", "build", "frontend", "web"];
const SCRIPT_PRIORITY = ["dev", "start", "preview"];

export interface FrontendTarget {
  /// Absoluter Pfad innerhalb des Workspace-Volumes – identisch sichtbar in
  /// diesem Prozess UND im Vorschau-Container (beide mounten dasselbe Volume
  /// unter /workspaces), deshalb ohne Übersetzung als FRONTEND_DIR verwendbar.
  dir: string;
  kind: "npm" | "static";
  scriptName?: string;
  /// Klartext fuer Log/Anzeige, z.B. "npm run dev (frontend/)".
  description: string;
}

async function readPackageJson(dir: string): Promise<{ scripts?: Record<string, string> } | null> {
  try {
    // `turbopackIgnore` wie in workspace.ts: der Pfad zeigt zur Laufzeit ins
    // Workspace-Volume, nie in den Quellbaum – ohne den Hinweis würde der
    // Build faelschlich das ganze Projekt fuer die Server-Ausgabe verfolgen.
    const raw = await readFile(/* turbopackIgnore: true */ path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function detectFrontend(repoDir: string): Promise<FrontendTarget | null> {
  const root = path.resolve(repoDir);

  for (const candidate of FRONTEND_CANDIDATE_DIRS) {
    const dir = path.resolve(root, candidate);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    const pkg = await readPackageJson(dir);
    const scriptName = SCRIPT_PRIORITY.find((name) => pkg?.scripts?.[name]);
    if (scriptName) {
      return {
        dir,
        kind: "npm",
        scriptName,
        description: `npm run ${scriptName}${candidate === "." ? "" : ` (${candidate}/)`}`,
      };
    }
  }

  for (const candidate of STATIC_CANDIDATE_DIRS) {
    const dir = path.resolve(root, candidate);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    try {
      await stat(/* turbopackIgnore: true */ path.join(dir, "index.html"));
      return {
        dir,
        kind: "static",
        description: `statische Dateien (${candidate === "." ? "Projektwurzel" : `${candidate}/`})`,
      };
    } catch {
      // kein index.html hier – naechster Kandidat
    }
  }

  return null;
}

// --- Ports --------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "0.0.0.0");
  });
}

/// Wahrheit ueber belegte Ports kommt aus der DB (gilt projektuebergreifend
/// und ueberlebt einen Neustart), der OS-Check ist nur ein zusaetzliches
/// Sicherheitsnetz gegen Fremdbelegung desselben Ports auf dem Host.
async function pickFreePort(excludeProjectId: string): Promise<number> {
  const { start, end } = portRange();
  const occupied = await prisma.project.findMany({
    where: { previewPort: { not: null }, id: { not: excludeProjectId } },
    select: { previewPort: true },
  });
  const used = new Set(occupied.map((p) => p.previewPort));

  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `Keine freie Vorschau-Portnummer zwischen ${start} und ${end} – zu viele laufende Vorschauen gleichzeitig.`,
  );
}

function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// --- Start / Stop ---------------------------------------------------------------

/// Kernlogik hinter dem Start-Knopf: startet einen frischen Sibling-Container
/// und kehrt sofort zurueck. Ob/wann er wirklich bedient, entscheidet
/// `getPreviewInfo` bei jedem Lesen live per `docker inspect` – hier gibt es
/// keinen Hintergrund-Task, der das nachverfolgt.
export async function startPreview(projectId: string): Promise<ActionResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project?.workspacePath) return fail("Das Team hat noch kein Repository angelegt – erst das Team starten.");

  const existing = await getPreviewInfo(projectId);
  if (existing.status === "RUNNING" || existing.status === "STARTING") {
    return note("Die Vorschau läuft bereits.");
  }

  const target = await detectFrontend(project.workspacePath);
  if (!target) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        previewStatus: "ERROR",
        previewError:
          "Kein Frontend gefunden – weder ein package.json mit dev/start/preview-Script noch eine index.html im Repository.",
        previewPort: null,
        previewContainerId: null,
      },
    });
    return fail("Kein Frontend im Repository gefunden.");
  }

  const name = containerName(projectId);
  // Ueberbleibsel eines vorherigen Laufs raeumen (z.B. nach einem Absturz),
  // sonst meldet `docker run` "name already in use".
  await docker(["rm", "-f", name]).catch(() => {});

  let port: number;
  try {
    port = await pickFreePort(projectId);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    dockerNetwork(),
    "-p",
    `${port}:${port}`,
    "-v",
    `${workspaceVolume()}:/workspaces`,
    // Ressourcenbegrenzung: ein hängender/entgleister Dev-Server reisst
    // weder den Docker-Host noch andere Vorschauen mit.
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    // Bewusst NUR das Noetigste im Environment – kein `...process.env`, das
    // waere sonst inklusive DATABASE_URL/ANTHROPIC_API_KEY an generierten
    // Code weitergereicht.
    "-e",
    `PORT=${port}`,
    "-e",
    `FRONTEND_DIR=${target.dir}`,
    "-e",
    `KIND=${target.kind}`,
  ];
  if (target.kind === "npm" && target.scriptName) args.push("-e", `SCRIPT_NAME=${target.scriptName}`);
  args.push(runnerImage());

  try {
    const containerId = await docker(args);
    await prisma.project.update({
      where: { id: projectId },
      data: {
        previewStatus: "STARTING",
        previewPort: port,
        previewContainerId: containerId.trim(),
        previewDir: target.dir,
        previewCommand: target.description,
        previewStartedAt: new Date(),
        previewError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.project.update({
      where: { id: projectId },
      data: { previewStatus: "ERROR", previewError: `Container-Start fehlgeschlagen: ${message}`, previewPort: null },
    });
    return fail("Vorschau-Container konnte nicht gestartet werden – Log unten prüft die Ursache.");
  }

  return ok(`Vorschau wird gestartet (${target.description}) …`);
}

/// Beendet den Sibling-Container einer Vorschau. `persist=false` fuer den
/// Fall, in dem das Projekt gleich darauf geloescht wird und ein DB-Update
/// ins Leere liefe.
export async function stopPreview(projectId: string, persist = true): Promise<ActionResult> {
  const name = containerName(projectId);
  await docker(["stop", "-t", "5", name]).catch(() => {});
  await docker(["rm", "-f", name]).catch(() => {});

  if (persist) {
    await prisma.project.update({
      where: { id: projectId },
      data: { previewStatus: "STOPPED", previewPort: null, previewContainerId: null, previewError: null },
    });
  }

  return ok("Vorschau gestoppt.");
}

/// Fuer `stopProjectWork` beim Loeschen eines Projekts: nur den Container
/// beenden, keine DB-Schreibvorgaenge (die Projektzeile ist gleich weg).
export async function killPreviewIfRunning(projectId: string): Promise<void> {
  const name = containerName(projectId);
  await docker(["rm", "-f", name]).catch(() => {});
}

/// Sicherheitsnetz gegen verwaiste Vorschau-Container – Gegenstueck zu
/// `reconcileOrphanWorkspaces` in worker/reconcile.ts, nur fuer Docker statt
/// Dateisystem.
///
/// `killPreviewIfRunning` schluckt seinen Fehler bewusst (Kommentar dort):
/// ist der Docker-Daemon in genau dem Moment kurz nicht erreichbar, oder
/// stirbt der App-Container zwischen `stopProjectWork` und dem eigentlichen
/// Loeschen, bleibt ein `scrumy-preview-<projectId>`-Container fuer ein
/// Projekt zurueck, das es (samt Workspace und DB-Zeile) laengst nicht mehr
/// gibt – er belegt weiter Port, RAM und CPU, unsichtbar fuer die
/// Oberflaeche, die nur Projekte kennt, die es noch gibt.
export async function reconcileOrphanPreviewContainers(): Promise<number> {
  const raw = await docker(["ps", "-a", "--format", "{{.Names}}"]).catch(() => "");
  const previewContainers = raw
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.startsWith("scrumy-preview-"));
  if (previewContainers.length === 0) return 0;

  const projectIds = previewContainers.map((name) => name.slice("scrumy-preview-".length));
  const known = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((project) => project.id));

  let removed = 0;
  for (const name of previewContainers) {
    if (knownIds.has(name.slice("scrumy-preview-".length))) continue;
    await docker(["rm", "-f", name]).catch(() => {});
    removed++;
  }
  return removed;
}

// --- Status lesen --------------------------------------------------------------

export interface PreviewInfo {
  status: PreviewStatus;
  port: number | null;
  command: string | null;
  startedAt: Date | null;
  error: string | null;
  log: string;
}

/// Liest den Vorschau-Status fuer die Oberflaeche – IMMER live per
/// `docker inspect`/`docker logs` statt einem gecachten Zustand zu
/// vertrauen, und schreibt Abweichungen direkt in die DB zurueck. Dadurch
/// ist es egal, ob "app" zwischendurch neu gestartet wurde oder mehrfach
/// laeuft: der Container ist die Wahrheit, nicht der Node-Prozess.
export async function getPreviewInfo(projectId: string): Promise<PreviewInfo> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      previewStatus: true,
      previewPort: true,
      previewCommand: true,
      previewStartedAt: true,
      previewError: true,
      previewContainerId: true,
    },
  });

  const base: PreviewInfo = {
    status: project.previewStatus,
    port: project.previewPort,
    command: project.previewCommand,
    startedAt: project.previewStartedAt,
    error: project.previewError,
    log: "",
  };

  // Kein Container bekannt: DB-Stand ist entweder STOPPED oder eine ERROR
  // aus der Erkennung (siehe startPreview) – beides braucht keinen Docker-Blick.
  if (!project.previewContainerId) return base;

  const name = containerName(projectId);
  const inspect = await docker([
    "inspect",
    "--format",
    "{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}",
    name,
  ]).catch(() => null);

  if (!inspect) {
    // Container existiert nicht (mehr) – von aussen gestoppt/entfernt.
    await prisma.project.update({
      where: { id: projectId },
      data: { previewStatus: "STOPPED", previewPort: null, previewContainerId: null, previewError: null },
    });
    return { ...base, status: "STOPPED", port: null, error: null };
  }

  const [running, , exitCodeRaw] = inspect.trim().split("|");
  const log = await docker(["logs", "--tail", String(LOG_LINES), name]).catch(() => "");

  if (running === "true") {
    const reachable = project.previewPort ? await canConnect(name, project.previewPort) : false;
    const status: PreviewStatus = reachable ? "RUNNING" : "STARTING";
    if (status !== project.previewStatus) {
      await prisma.project.update({ where: { id: projectId }, data: { previewStatus: status, previewError: null } });
    }
    return { ...base, status, error: null, log };
  }

  // Container ist beendet, aber noch da (kein --rm, siehe stopPreview): das
  // war unerwartet, sonst haette stopPreview ihn schon entfernt.
  const exitCode = exitCodeRaw ?? "?";
  const message = `Der Server ist unerwartet beendet worden (Code ${exitCode}). Log unten prüft die Ursache.`;
  await prisma.project.update({
    where: { id: projectId },
    data: { previewStatus: "ERROR", previewError: message, previewPort: null },
  });
  return { ...base, status: "ERROR", port: null, error: message, log };
}
