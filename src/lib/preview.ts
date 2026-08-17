// Vorschau-Modus: startet das Frontend, das das Team im Projekt-Repo gebaut
// hat, als echten laufenden Prozess und macht ihn im Browser ansichtbar.
//
// Die Agenten sind frei in der Technologiewahl (siehe teamKickoff.ts), es gibt
// also keinen festen Build-Befehl. `detectFrontend` sucht deshalb heuristisch
// nach einem `package.json` mit einem `dev`/`start`/`preview`-Script oder,
// ohne Bundler, nach einer statischen `index.html`.
//
// Architektur bewusst OHNE Pfad-Proxy (z.B. "/projects/x/preview/proxy/..."):
// generierte Frontends verlinken ihre Assets fast immer absolut ("/assets/…"),
// was unter einem Pfadpräfix bricht, sobald der Browser diese Pfade gegen die
// Seitenwurzel statt gegen den Präfix auflöst. Stattdessen bekommt jede
// laufende Vorschau einen echten Port aus einem festen, in docker-compose.yml
// veröffentlichten Bereich (PREVIEW_PORT_RANGE_START..END) – das iframe zeigt
// direkt auf `http://<host>:<port>/`, die App läuft an ihrer eigenen
// Seitenwurzel, genau wie ihr Bundler es erwartet. Nebeneffekt: WebSockets
// (Vite/Next-HMR) funktionieren dadurch sogar mit, ganz ohne eigenen
// WS-Proxy-Code.
//
// Prozesse leben nur im Speicher DIESES App-Prozesses (analog zum Muster in
// worker/llmProfileLimiter.ts) – bei `--scale app=N` säße die Vorschau eines
// Projekts u.U. im falschen Replica. Für den aktuellen Umfang (nur `app`
// skaliert i.d.R. nicht, siehe docker-compose.yml) ist das die bewusst
// einfachere Wahl.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import type { PreviewStatus } from "@/generated/prisma/client";

const LOG_LINES_KEPT = 200;
const READY_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

interface PreviewState {
  child: ChildProcess | null;
  server: HttpServer | null;
  port: number;
  logs: string[];
  /// Wird beim Beenden hochgezaehlt, damit ein spaeter feuernder `exit`-Handler
  /// eines bereits abgeloesten Kindprozesses (nach Stop+Neustart) den neuen
  /// Zustand nicht ueberschreibt.
  generation: number;
}

const active = new Map<string, PreviewState>();

function appendLog(state: PreviewState, chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (line.trim().length === 0) continue;
    state.logs.push(line);
  }
  if (state.logs.length > LOG_LINES_KEPT) {
    state.logs.splice(0, state.logs.length - LOG_LINES_KEPT);
  }
}

function portRange(): { start: number; end: number } {
  const start = Number(process.env.PREVIEW_PORT_RANGE_START ?? 4100);
  const end = Number(process.env.PREVIEW_PORT_RANGE_END ?? 4119);
  return { start, end };
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "0.0.0.0");
  });
}

async function pickFreePort(): Promise<number> {
  const { start, end } = portRange();
  const used = new Set([...active.values()].map((s) => s.port));
  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `Keine freie Vorschau-Portnummer zwischen ${start} und ${end} – zu viele laufende Vorschauen gleichzeitig.`,
  );
}

function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: "127.0.0.1" });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Frontend-Erkennung ------------------------------------------------------

const FRONTEND_CANDIDATE_DIRS = [".", "frontend", "web", "client", "app", "ui"];
const STATIC_CANDIDATE_DIRS = [".", "public", "dist", "build", "frontend", "web"];
const SCRIPT_PRIORITY = ["dev", "start", "preview"];

export interface FrontendTarget {
  /// Absoluter Pfad innerhalb des Repos, in dem der Server laeuft.
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

// --- Statischer Fallback-Server ---------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function startStaticServer(dir: string, port: number): HttpServer {
  const root = path.resolve(dir);
  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://internal");
        let relative = decodeURIComponent(url.pathname);
        if (relative.endsWith("/")) relative += "index.html";
        const target = path.resolve(root, `.${relative}`);
        if (target !== root && !target.startsWith(root + path.sep)) {
          res.writeHead(403).end("Verboten");
          return;
        }

        let data;
        try {
          data = await readFile(/* turbopackIgnore: true */ target);
        } catch {
          // Kein Treffer und keine Dateiendung: vermutlich eine Client-Route
          // eines SPA-Routers – mit index.html beantworten statt 404.
          data = path.extname(target)
            ? null
            : await readFile(/* turbopackIgnore: true */ path.join(root, "index.html")).catch(() => null);
        }
        if (!data) {
          res.writeHead(404).end("Nicht gefunden");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" });
        res.end(data);
      } catch (error) {
        res.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    })();
  });
  server.listen(port, "0.0.0.0");
  return server;
}

// --- Start / Stop -------------------------------------------------------------

function isCurrent(projectId: string, state: PreviewState, generation: number): boolean {
  return active.get(projectId) === state && state.generation === generation;
}

async function markRunning(projectId: string): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { previewStatus: "RUNNING", previewError: null } });
}

async function markError(projectId: string, state: PreviewState, message: string): Promise<void> {
  appendLog(state, `✗ ${message}`);
  await prisma.project
    .update({ where: { id: projectId }, data: { previewStatus: "ERROR", previewError: message } })
    .catch(() => {});
}

async function waitUntilReady(projectId: string, state: PreviewState, generation: number, port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isCurrent(projectId, state, generation)) return false;
    if (await canConnect(port)) return true;
    await sleep(700);
  }
  return false;
}

/// Kernlogik hinter dem Start-Knopf. Kehrt sofort zurueck (Status STARTING);
/// npm install + Prozessstart laufen im Hintergrund weiter (siehe `launch`).
export async function startPreview(projectId: string): Promise<ActionResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspacePath: true },
  });
  if (!project?.workspacePath) return fail("Das Team hat noch kein Repository angelegt – erst das Team starten.");

  const existing = active.get(projectId);
  if (existing?.child && existing.child.exitCode === null) return note("Die Vorschau läuft bereits.");
  if (existing?.server) return note("Die Vorschau läuft bereits.");

  const target = await detectFrontend(project.workspacePath);
  if (!target) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        previewStatus: "ERROR",
        previewError:
          "Kein Frontend gefunden – weder ein package.json mit dev/start/preview-Script noch eine index.html im Repository.",
        previewPort: null,
        previewPid: null,
      },
    });
    return fail("Kein Frontend im Repository gefunden.");
  }

  const port = await pickFreePort().catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });

  const state: PreviewState = { child: null, server: null, port, logs: [], generation: (existing?.generation ?? 0) + 1 };
  active.set(projectId, state);

  await prisma.project.update({
    where: { id: projectId },
    data: {
      previewStatus: "STARTING",
      previewPort: port,
      previewPid: null,
      previewDir: target.dir,
      previewCommand: target.description,
      previewStartedAt: new Date(),
      previewError: null,
    },
  });

  launch(projectId, target, port, state, state.generation).catch(async (error) => {
    if (!isCurrent(projectId, state, state.generation)) return;
    await markError(projectId, state, error instanceof Error ? error.message : String(error));
  });

  return ok(`Vorschau wird gestartet (${target.description}) …`);
}

async function launch(
  projectId: string,
  target: FrontendTarget,
  port: number,
  state: PreviewState,
  generation: number,
): Promise<void> {
  if (target.kind === "static") {
    state.server = startStaticServer(target.dir, port);
    appendLog(state, `Statischer Server gestartet auf Port ${port}.`);
    if (isCurrent(projectId, state, generation)) await markRunning(projectId);
    return;
  }

  const hasNodeModules = await stat(/* turbopackIgnore: true */ path.join(target.dir, "node_modules")).then(
    () => true,
    () => false,
  );
  if (!hasNodeModules) {
    appendLog(state, "$ npm install");
    const installed = await runToCompletion("npm", ["install"], target.dir, state, INSTALL_TIMEOUT_MS);
    if (!isCurrent(projectId, state, generation)) return;
    if (!installed) {
      await markError(projectId, state, "„npm install“ ist fehlgeschlagen – Log unten prüft die Ursache.");
      return;
    }
  }

  appendLog(state, `$ npm run ${target.scriptName}`);
  const child = spawn("npm", ["run", target.scriptName ?? "dev"], {
    cwd: target.dir,
    env: { ...process.env, PORT: String(port), HOST: "0.0.0.0", BROWSER: "none", CI: "true" },
  });
  state.child = child;

  await prisma.project.update({ where: { id: projectId }, data: { previewPid: child.pid ?? null } }).catch(() => {});

  child.stdout?.on("data", (chunk: Buffer) => appendLog(state, chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(state, chunk.toString()));
  child.on("exit", (code) => {
    if (!isCurrent(projectId, state, generation)) return; // gewollt gestoppt/abgeloest
    void markError(projectId, state, `Der Server ist unerwartet beendet worden (Code ${code ?? "?"}).`);
  });

  const ready = await waitUntilReady(projectId, state, generation, port);
  if (!isCurrent(projectId, state, generation)) return;
  if (ready) {
    await markRunning(projectId);
  } else {
    await markError(projectId, state, "Der Server antwortet nach 60 Sekunden nicht – Log unten prüfen.");
  }
}

function runToCompletion(
  command: string,
  args: string[],
  cwd: string,
  state: PreviewState,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      appendLog(state, `✗ Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)}s.`);
      resolve(false);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => appendLog(state, chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => appendLog(state, chunk.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      appendLog(state, `✗ ${error.message}`);
      resolve(false);
    });
  });
}

/// Beendet eine laufende Vorschau. `persist=false` fuer den Fall, in dem das
/// Projekt gleich darauf geloescht wird und ein DB-Update ins Leere liefe.
export async function stopPreview(projectId: string, persist = true): Promise<ActionResult> {
  const state = active.get(projectId);
  active.delete(projectId);

  if (state) {
    state.generation += 1; // laesst spaeter feuernde exit-Handler verstummen
    state.server?.close();
    const pid = state.child?.pid;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Prozess ist schon weg */
      }
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* schon beendet */
        }
      }, 5000);
    }
  } else {
    // Kein In-Memory-Zustand (z.B. nach einem Neustart des App-Containers),
    // aber laut DB laeuft noch etwas: letzten bekannten PID-Versuch wagen.
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { previewPid: true } });
    if (project?.previewPid) {
      try {
        process.kill(project.previewPid, "SIGTERM");
      } catch {
        /* Prozess existiert nicht mehr (anderer Container-Neustart) */
      }
    }
  }

  if (persist) {
    await prisma.project.update({
      where: { id: projectId },
      data: { previewStatus: "STOPPED", previewPort: null, previewPid: null, previewError: null },
    });
  }

  return ok("Vorschau gestoppt.");
}

/// Fuer `stopProjectWork` beim Loeschen eines Projekts: nur den Prozess
/// beenden, keine DB-Schreibvorgaenge (die Projektzeile ist gleich weg).
export async function killPreviewIfRunning(projectId: string): Promise<void> {
  if (!active.has(projectId)) return;
  await stopPreview(projectId, false);
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

/// Liest den Vorschau-Status fuer die Oberflaeche. Gleicht dabei mit dem
/// In-Memory-Zustand ab: Meldet die DB "läuft"/"startet", ohne dass DIESER
/// Prozess einen passenden Kindprozess kennt (Neustart des App-Containers),
/// ist der gemeldete Zustand veraltet – dann wird er hier auf STOPPED
/// zurueckgesetzt, statt der Oberflaeche ewig "läuft" vorzugaukeln.
export async function getPreviewInfo(projectId: string): Promise<PreviewInfo> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      previewStatus: true,
      previewPort: true,
      previewCommand: true,
      previewStartedAt: true,
      previewError: true,
    },
  });

  const state = active.get(projectId);
  const stale = !state && (project.previewStatus === "RUNNING" || project.previewStatus === "STARTING");
  if (stale) {
    await prisma.project.update({
      where: { id: projectId },
      data: { previewStatus: "STOPPED", previewPort: null, previewPid: null },
    });
    return { status: "STOPPED", port: null, command: null, startedAt: null, error: null, log: "" };
  }

  return {
    status: project.previewStatus,
    port: project.previewPort,
    command: project.previewCommand,
    startedAt: project.previewStartedAt,
    error: project.previewError,
    log: state ? state.logs.slice(-40).join("\n") : "",
  };
}
