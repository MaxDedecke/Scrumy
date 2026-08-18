// Live-Anwendung: startet den GANZEN Docker-Compose-Stack, den das Team im
// Projekt-Repo gebaut hat (Frontend, Backend, Datenbank – siehe
// TEAM_GRUNDREGELN in worker/projectContext.ts), statt wie die Vorschau (src/
// lib/preview.ts) nur das Frontend als Dev-Server.
//
// Zwei Aufrufer:
//  * Der Mensch über den "Anwendung starten"-Knopf im Projektkopf (siehe
//    src/lib/actions/live.ts) – zum echten Durchklicken mit Backend und DB.
//  * QA automatisch einmal pro Sprint-Review (siehe worker/tasks/
//    sprintReview.ts, `runSprintIntegrationCheck`) – NICHT pro Ticket, das
//    waere wegen der Ein-Projekt-Grenze unten zu teuer.
//
// Architektur wie preview.ts (siehe dessen Kopfkommentar fuer die volle
// Begruendung: Isolation, Blast Radius, kein Bind-Mount-Pfad-Problem dank
// Docker-Volume) – mit zwei Unterschieden:
//  * "docker compose" statt "docker run": der Kunden-Stack bringt seine
//    eigene docker-compose.yml mit, Scrumy fuehrt sie nur aus.
//  * Start ("up -d --build") wird detached gespawnt statt synchron erwartet:
//    ein Build kann Minuten dauern, das darf einen Server-Action-Aufruf nicht
//    blockieren. getLiveStackInfo ist wie getPreviewInfo die einzige
//    Wahrheitsquelle beim Lesen.
//
// Nur EIN Projekt darf gleichzeitig live sein (siehe getOtherLiveProject) –
// mehrere gleichzeitig ist bewusst spaetere Arbeit, nicht Teil dieses Moduls.
//
// Bekannte Einschraenkung: Weil "docker compose up" hier als Sibling-Aufruf
// gegen den Docker-Socket des HOSTS laeuft, werden relative Bind-Mounts in
// der Kunden-docker-compose.yml (z.B. "./frontend:/app" fuer Hot-Reload) vom
// Daemon als Host-Pfad aufgeloest, den es dort nicht gibt – derselbe Grund,
// warum preview.ts nie Bind-Mounts nutzt (siehe dessen Kommentar). Build-
// Contexts sind unproblematisch (das CLI liest sie lokal und laedt sie hoch).
// TEAM_GRUNDREGELN weist die Agenten deshalb an, Code beim Build zu kopieren.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import type { LiveTrigger, PreviewStatus } from "@/generated/prisma/client";

const execFileAsync = promisify(execFile);

const LOG_LINES = 60;
const START_TIMEOUT_MS = 15 * 60 * 1000; // Grosszuegig: "npm ci" fuer mehrere Dienste + Build.

/// Compose-Standardreihenfolge (dieselbe wie das "docker compose"-CLI selbst
/// beim Suchen ohne "-f").
const COMPOSE_FILENAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

async function findComposeFile(repoDir: string): Promise<string | null> {
  for (const name of COMPOSE_FILENAMES) {
    const candidate = path.join(repoDir, name);
    try {
      // `turbopackIgnore` wie in preview.ts: der Pfad zeigt zur Laufzeit ins
      // Workspace-Volume, nie in den Quellbaum – ohne den Hinweis würde der
      // Build faelschlich das ganze Projekt fuer die Server-Ausgabe verfolgen.
      await stat(/* turbopackIgnore: true */ candidate);
      return candidate;
    } catch {
      // naechster Kandidat
    }
  }
  return null;
}

/// Wie containerName() in preview.ts: an die Projekt-ID gebunden, niemals ein
/// von aussen beeinflussbarer Wert.
function liveProjectName(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`Ungültige Projekt-ID: ${projectId}`);
  return `scrumy-live-${projectId}`;
}

function liveLogPath(projectId: string): string {
  return `/tmp/scrumy-live-${projectId}.log`;
}

const START_MARKER = "__SCRUMY_COMPOSE_UP__";

function readLiveLog(projectId: string): string {
  try {
    const raw = readFileSync(liveLogPath(projectId), "utf8");
    const lines = raw.split("\n");
    return lines.slice(-LOG_LINES).join("\n").trim();
  } catch {
    return "";
  }
}

/// Oeffnet die Log-Datei zum Schreiben ("w") – best effort. Ein Rest aus
/// einem frueheren Lauf, der aus welchem Grund auch immer einem anderen
/// Nutzer gehoert (z.B. ein Container, der kurzzeitig als root lief), blockt
/// sonst auf Dauer JEDEN weiteren Start dieses Projekts: /tmp traegt das
/// Sticky-Bit, also darf nur der Eigentuemer die Datei loeschen – "unlinkSync"
/// schlaegt dann ebenfalls fehl, das faengt der aeussere try/catch ab. Die
/// Log-Datei ist reine Diagnose (Anzeige im "Zuletzt"-Panel, siehe
/// readLiveLog); wenn sie partout nicht anzulegen ist, startet der Stack
/// trotzdem – nur ohne Log-Tail statt mit "nix passiert".
function openLiveLog(projectId: string): number | null {
  const logPath = liveLogPath(projectId);
  try {
    return openSync(logPath, "w");
  } catch {
    try {
      unlinkSync(logPath);
      return openSync(logPath, "w");
    } catch (error) {
      console.error(`Live-Log fuer Projekt ${projectId} konnte nicht angelegt werden, starte ohne Log:`, error);
      return null;
    }
  }
}

async function docker(args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 5 * 1024 * 1024, timeout: timeoutMs });
  return stdout;
}

async function dockerCompose(args: string[], timeoutMs = 20_000): Promise<string> {
  return docker(["compose", ...args], timeoutMs);
}

// --- Aufraeumen -----------------------------------------------------------

/// Entfernt einen Compose-Stack komplett anhand seines Projekt-Labels –
/// braucht dafuer KEINE Compose-Datei (anders als "docker compose down"),
/// funktioniert also auch, wenn das Workspace laengst weg ist (Aufraeumen
/// nach Projekt-Loeschung, siehe purge.ts/reconcileOrphanLiveStacks).
/// Volumes werden IMMER mitentfernt: aktuell keine Persistenz zwischen zwei
/// Live-Laeufen (siehe liveKeepData-Kommentar in prisma/schema.prisma).
async function removeStackByLabel(name: string): Promise<void> {
  const label = `label=com.docker.compose.project=${name}`;

  const containerIds = (await docker(["ps", "-a", "-q", "--filter", label]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (containerIds.length > 0) await docker(["rm", "-f", ...containerIds]).catch(() => {});

  const networkIds = (await docker(["network", "ls", "-q", "--filter", label]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const id of networkIds) await docker(["network", "rm", id]).catch(() => {});

  const volumeNames = (await docker(["volume", "ls", "-q", "--filter", label]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const volume of volumeNames) await docker(["volume", "rm", volume]).catch(() => {});
}

// --- Sperre: nur ein Projekt gleichzeitig live -----------------------------

/// Findet ein ANDERES Projekt, das gerade live ist (oder gerade startet) –
/// Grundlage sowohl fuer die Ablehnung in startLiveStack als auch fuer den
/// deaktivierten Play-Knopf in der Oberflaeche (siehe LiveAppControls).
export async function getOtherLiveProject(
  excludeProjectId: string | null,
): Promise<{ id: string; name: string } | null> {
  return prisma.project.findFirst({
    where: {
      liveStatus: { in: ["STARTING", "RUNNING"] },
      ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
    },
    select: { id: true, name: true },
  });
}

// --- Start / Stop -----------------------------------------------------------

/// Kernlogik hinter dem "Anwendung starten"-Knopf: startet "docker compose up
/// -d --build" detached (siehe Kopfkommentar) und kehrt sofort zurueck. Ob/
/// wann der Stack wirklich bedient, entscheidet getLiveStackInfo bei jedem
/// Lesen live per "docker compose ps".
export async function startLiveStack(projectId: string, trigger: LiveTrigger = "MANUAL"): Promise<ActionResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true, liveStatus: true },
  });
  if (!project?.workspacePath) return fail("Das Team hat noch kein Repository angelegt – erst das Team starten.");

  if (project.liveStatus === "RUNNING" || project.liveStatus === "STARTING") {
    return note("Die Anwendung läuft bereits.");
  }

  const blocker = await getOtherLiveProject(projectId);
  if (blocker) {
    return fail(
      `„${blocker.name}" ist gerade live – aktuell kann nur ein Projekt gleichzeitig live sein. Dort erst beenden.`,
    );
  }

  const composeFile = await findComposeFile(project.workspacePath);
  if (!composeFile) {
    await prisma.project.update({
      where: { id: projectId },
      data: { liveStatus: "ERROR", liveError: "Kein docker-compose.yml im Repository gefunden.", livePort: null, liveService: null },
    });
    return fail("Kein docker-compose.yml im Repository gefunden.");
  }

  const name = liveProjectName(projectId);
  // Ueberbleibsel eines vorherigen (abgestuerzten) Laufs raeumen, wie preview.ts es mit "docker rm -f" tut.
  await removeStackByLabel(name).catch(() => {});

  const logPath = liveLogPath(projectId);
  const fd = openLiveLog(projectId);

  try {
    const child = spawn(
      "docker",
      ["compose", "-f", composeFile, "-p", name, "up", "-d", "--build", "--remove-orphans"],
      { stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"], detached: true },
    );
    child.on("close", (code) => {
      if (fd === null) return;
      try {
        appendFileSync(logPath, `\n${START_MARKER} exit=${code}\n`);
        closeSync(fd);
      } catch {
        // Log-Datei nicht mehr da/schreibbar – kein Beinbruch, getLiveStackInfo
        // faellt dann auf die Zeitlimit-Erkennung zurueck.
      }
    });
    child.unref();
  } catch (error) {
    if (fd !== null) closeSync(fd);
    const message = error instanceof Error ? error.message : String(error);
    await prisma.project.update({
      where: { id: projectId },
      data: { liveStatus: "ERROR", liveError: `Start fehlgeschlagen: ${message}`, livePort: null, liveService: null },
    });
    return fail("Anwendung konnte nicht gestartet werden.");
  }

  await prisma.project.update({
    where: { id: projectId },
    data: {
      liveStatus: "STARTING",
      liveTrigger: trigger,
      liveStartedAt: new Date(),
      liveError: null,
      livePort: null,
      liveService: null,
    },
  });

  return ok("Anwendung wird gestartet – das kann beim ersten Mal (Build) einige Minuten dauern …");
}

/// Beendet die Live-Anwendung. `persist=false` fuer stopProjectWork beim
/// Loeschen eines Projekts (kein DB-Update noetig, die Zeile ist gleich weg).
export async function stopLiveStack(projectId: string, persist = true): Promise<ActionResult> {
  await removeStackByLabel(liveProjectName(projectId));

  if (persist) {
    await prisma.project.update({
      where: { id: projectId },
      data: { liveStatus: "STOPPED", liveTrigger: null, livePort: null, liveService: null, liveError: null },
    });
  }

  return ok("Anwendung beendet.");
}

/// Fuer purge.ts beim Loeschen eines Projekts – nur den Stack entfernen, kein
/// DB-Schreibvorgang (analog killPreviewIfRunning).
export async function killLiveStackIfRunning(projectId: string): Promise<void> {
  await removeStackByLabel(liveProjectName(projectId)).catch(() => {});
}

/// Sicherheitsnetz gegen verwaiste Live-Stacks – Gegenstueck zu
/// reconcileOrphanPreviewContainers in preview.ts, nur ueber
/// "docker compose ls" statt "docker ps" (ein Stack ist hier mehrere
/// Container plus Netz/Volume, nicht ein einzelner Container).
export async function reconcileOrphanLiveStacks(): Promise<number> {
  const raw = await dockerCompose(["ls", "-a", "--format", "json"]).catch(() => "");
  let stackNames: string[];
  try {
    const parsed = JSON.parse(raw.trim() || "[]") as Array<{ Name: string }>;
    stackNames = parsed.map((entry) => entry.Name).filter((n) => n.startsWith("scrumy-live-"));
  } catch {
    stackNames = [];
  }
  if (stackNames.length === 0) return 0;

  const projectIds = stackNames.map((name) => name.slice("scrumy-live-".length));
  const known = await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true } });
  const knownIds = new Set(known.map((project) => project.id));

  let removed = 0;
  for (const name of stackNames) {
    if (knownIds.has(name.slice("scrumy-live-".length))) continue;
    await removeStackByLabel(name).catch(() => {});
    removed++;
  }
  return removed;
}

// --- Status lesen ------------------------------------------------------------

interface ComposePublisher {
  PublishedPort?: number;
}
interface ComposePsEntry {
  Service: string;
  State: string;
  /// "" ohne Healthcheck, sonst "starting"/"healthy"/"unhealthy" – siehe
  /// Status-Bestimmung unten. Kein TCP-Probe wie preview.ts: der Live-Stack
  /// bringt sein eigenes, von den Agenten frei angelegtes Compose-Netz mit,
  /// in dem "app" nicht drinsteckt (anders als der feste "scrumy_preview"-
  /// Netz der Vorschau) – ein Port waere von hier aus nicht erreichbar, ohne
  /// "app" jedes Mal in ein fremdes Netz haengen zu muessen. Container-Status
  /// (+ Healthcheck, falls vorhanden) ist der pragmatischere Signalgeber.
  Health?: string;
  ExitCode?: number;
  Publishers?: ComposePublisher[];
}

function parseComposePs(raw: string): ComposePsEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Kein einzelnes JSON-Array – manche Compose-Versionen liefern NDJSON, siehe unten.
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ComposePsEntry];
      } catch {
        return [];
      }
    });
}

/// Bevorzugt einen Dienst, dessen Name nach Frontend klingt (dieselbe Art
/// Heuristik wie FRONTEND_CANDIDATE_DIRS in preview.ts), sonst den mit dem
/// niedrigsten veroeffentlichten Port.
function pickEntryPoint(entries: ComposePsEntry[]): { service: string; port: number } | null {
  const published = entries.flatMap((entry) =>
    (entry.Publishers ?? [])
      .map((publisher) => publisher.PublishedPort)
      // "0" heisst NICHT veroeffentlicht (z.B. ein Dienst ganz ohne "ports:",
      // nur mit implizitem EXPOSE) – docker compose meldet trotzdem einen
      // Publishers-Eintrag dafuer, nur eben mit PublishedPort 0.
      .filter((port): port is number => typeof port === "number" && port > 0)
      .map((port) => ({ service: entry.Service, port })),
  );
  if (published.length === 0) return null;
  const named = published.find((candidate) => /front|web|client|ui/i.test(candidate.service));
  if (named) return named;
  return published.reduce((min, candidate) => (candidate.port < min.port ? candidate : min));
}

export interface LiveStackInfo {
  status: PreviewStatus;
  port: number | null;
  service: string | null;
  trigger: LiveTrigger | null;
  startedAt: Date | null;
  error: string | null;
  log: string;
}

/// Liest den Live-Status fuer Oberflaeche UND Sprint-Review-Check – IMMER live
/// per "docker compose ps" statt einem gecachten Zustand zu vertrauen (wie
/// getPreviewInfo), Abweichungen werden direkt in die DB zurueckgeschrieben.
export async function getLiveStackInfo(projectId: string): Promise<LiveStackInfo> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      workspacePath: true,
      liveStatus: true,
      livePort: true,
      liveService: true,
      liveTrigger: true,
      liveStartedAt: true,
      liveError: true,
    },
  });

  const base: LiveStackInfo = {
    status: project.liveStatus,
    port: project.livePort,
    service: project.liveService,
    trigger: project.liveTrigger,
    startedAt: project.liveStartedAt,
    error: project.liveError,
    log: "",
  };

  // Nichts zu tun bekannt: kein Docker-Blick noetig (schneller Pfad wie in getPreviewInfo).
  if (project.liveStatus === "STOPPED" || !project.workspacePath) return base;

  const name = liveProjectName(projectId);
  const composeFile = await findComposeFile(project.workspacePath);
  const psRaw = composeFile
    ? await dockerCompose(["-f", composeFile, "-p", name, "ps", "-a", "--format", "json"]).catch(() => "")
    : "";
  const entries = parseComposePs(psRaw);

  // "docker compose up" ist bereits beendet (siehe START_MARKER-Eintrag in
  // startLiveStack) UND nicht erfolgreich: das ist ein endgueltiges Scheitern,
  // selbst wenn einzelne Container es noch bis "created" geschafft haben
  // (z.B. Postgres laeuft, der naechste Dienst scheitert am Port). Ohne diese
  // Prüfung bliebe der Status faelschlich "STARTING", bis das grosszuegige
  // Zeitlimit unten abläuft.
  const startLog = readLiveLog(projectId);
  const exitMatch = startLog.match(new RegExp(`${START_MARKER} exit=(-?\\d+)`));
  if (exitMatch && Number(exitMatch[1]) !== 0) {
    const message = `Start fehlgeschlagen (Exit-Code ${exitMatch[1]}). Log unten prüft die Ursache.`;
    await prisma.project.update({
      where: { id: projectId },
      data: { liveStatus: "ERROR", liveError: message, livePort: null, liveService: null },
    });
    return { ...base, status: "ERROR", port: null, service: null, error: message, log: startLog };
  }

  if (entries.length === 0) {
    if (exitMatch) {
      // exit=0, aber trotzdem keine Dienste – z.B. eine docker-compose.yml ohne "services:".
      const message = "Der Compose-Stack wurde ausgeführt, hat aber keine Dienste erzeugt – docker-compose.yml prüfen.";
      await prisma.project.update({
        where: { id: projectId },
        data: { liveStatus: "ERROR", liveError: message, livePort: null, liveService: null },
      });
      return { ...base, status: "ERROR", port: null, service: null, error: message, log: startLog };
    }
    const staleMs = project.liveStartedAt ? Date.now() - project.liveStartedAt.getTime() : 0;
    if (staleMs > START_TIMEOUT_MS) {
      const message = "Zeitlimit beim Start überschritten (möglicherweise durch einen Neustart von Scrumy unterbrochen).";
      await prisma.project.update({
        where: { id: projectId },
        data: { liveStatus: "ERROR", liveError: message, livePort: null, liveService: null },
      });
      return { ...base, status: "ERROR", port: null, service: null, error: message, log: startLog };
    }
    return { ...base, status: "STARTING", log: startLog };
  }

  const log = await dockerCompose(["-p", name, "logs", "--tail", String(LOG_LINES)]).catch(() => "");
  const failed = entries.find((entry) => entry.State === "exited" && (entry.ExitCode ?? 0) !== 0);
  if (failed) {
    const message = `Dienst „${failed.Service}" ist unerwartet beendet worden (Code ${failed.ExitCode}). Log unten prüft die Ursache.`;
    await prisma.project.update({
      where: { id: projectId },
      data: { liveStatus: "ERROR", liveError: message, livePort: null, liveService: null },
    });
    return { ...base, status: "ERROR", port: null, service: null, error: message, log };
  }

  const entryPoint = pickEntryPoint(entries);
  const allRunning = entries.every((entry) => entry.State === "running");
  const allHealthy = entries.every((entry) => !entry.Health || entry.Health === "healthy");
  const status: PreviewStatus = allRunning && allHealthy ? "RUNNING" : "STARTING";

  if (
    status !== project.liveStatus ||
    entryPoint?.port !== project.livePort ||
    entryPoint?.service !== project.liveService
  ) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        liveStatus: status,
        livePort: entryPoint?.port ?? null,
        liveService: entryPoint?.service ?? null,
        liveError: null,
      },
    });
  }

  return { ...base, status, port: entryPoint?.port ?? null, service: entryPoint?.service ?? null, error: null, log };
}

// --- Sprint-Review-Integrationspruefung --------------------------------------

export type IntegrationCheckResult =
  | { skipped: true; reason: string }
  | { skipped: false; passed: boolean; summary: string };

/// Fuer worker/tasks/sprintReview.ts: bringt den vollen Stack einmal hoch,
/// wartet bis er erreichbar ist (oder das Zeitlimit reisst), faehrt ihn
/// danach IMMER wieder runter (try/finally) – die "nur ein Projekt live"-
/// Sperre gilt hier genauso wie fuer den Playbutton, ein belegter Slot fuehrt
/// zu einem uebersprungenen statt blockierenden Check.
export async function runSprintIntegrationCheck(
  projectId: string,
  { pollIntervalMs = 5000, timeoutMs = 5 * 60 * 1000 } = {},
): Promise<IntegrationCheckResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspacePath: true } });
  if (!project?.workspacePath) return { skipped: true, reason: "Kein Arbeitsverzeichnis." };

  const composeFile = await findComposeFile(project.workspacePath);
  if (!composeFile) return { skipped: true, reason: "Kein docker-compose.yml im Repository gefunden." };

  const blocker = await getOtherLiveProject(projectId);
  if (blocker) return { skipped: true, reason: `„${blocker.name}" ist gerade live – Integrationsprüfung übersprungen.` };

  const started = await startLiveStack(projectId, "SPRINT_REVIEW");
  if (started.status === "error") return { skipped: true, reason: started.message };
  // "info" heisst: die Anwendung lief schon (z.B. ein Mensch testet gerade
  // manuell ueber den Playbutton) – dann NICHT selbst gestartet, also am Ende
  // auch nicht selbst beenden. Sonst reisst die automatische Pruefung einer
  // Person mitten in der Sitzung die App weg.
  const ownsLifecycle = started.status === "success";

  try {
    const deadline = Date.now() + timeoutMs;
    let info = await getLiveStackInfo(projectId);
    while (info.status === "STARTING" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      info = await getLiveStackInfo(projectId);
    }

    if (info.status === "RUNNING") {
      return {
        skipped: false,
        passed: true,
        summary: `Voller Stack erreichbar (Dienst „${info.service ?? "?"}", Port ${info.port ?? "?"}).`,
      };
    }

    const reason =
      info.status === "STARTING"
        ? "Zeitlimit erreicht, bevor der Stack erreichbar war."
        : (info.error ?? "Unbekannter Fehler beim Start.");
    return {
      skipped: false,
      passed: false,
      summary: `Voller Stack NICHT erreichbar: ${reason}${info.log ? `\n\nLog:\n${info.log}` : ""}`,
    };
  } finally {
    if (ownsLifecycle) await stopLiveStack(projectId);
  }
}
