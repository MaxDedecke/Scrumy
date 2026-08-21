// Echte, automatische Prüfungen im Projekt-Repo – kein Modell, das sich
// vorstellt, ob "npm test" wohl durchläuft, sondern ein tatsächlicher Lauf mit
// echtem Exit-Code. Damit QA (siehe worker/tasks/ticketWork.ts) genauso
// arbeiten kann wie ein Mensch mit Terminal: Befehl ausführen, Ergebnis lesen,
// danach urteilen – statt aus der Diff-Ansicht zu raten oder, schlimmer, dem
// Auftraggeber eine Frage vorzulegen, die eigentlich nur "wurde getestet?"
// bedeutet.
//
// Läuft als eigener, ressourcenbegrenzter Sibling-Container aus demselben
// generischen Image wie die Frontend-Vorschau (docker/preview-runner.Dockerfile
// – node+npm, richtige UID fürs Workspace-Volume), aber synchron statt
// dauerhaft: `docker run` OHNE `-d` läuft bis der Befehl fertig ist, die
// Ausgabe kommt direkt über stdout/stderr zurück, kein `docker logs` nötig.
// Kein eigenes Docker-Netz (anders als die Vorschau): der Lauf muss niemand
// erreichen und niemand muss ihn erreichen, nur `npm install` braucht Internet
// – das Standard-Bridge-Netz reicht, isoliert von db/app/worker sowieso.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listTrackedFiles, readRepoFile } from "@/lib/workspace";

const execFileAsync = promisify(execFile);

/// Auch fuer runHttpProbe in liveStack.ts: derselbe generische Node-Runner,
/// nur mit "--network host" statt Volume-Mount (siehe dort).
export function testRunnerImage(): string {
  return process.env.TEST_RUNNER_IMAGE || process.env.PREVIEW_RUNNER_IMAGE || "scrumy-preview-runner";
}
function testRunnerVolume(): string {
  return process.env.TEST_RUNNER_WORKSPACE_VOLUME || process.env.PREVIEW_WORKSPACE_VOLUME || "scrumy_scrumy_workspaces";
}

/// Führt ein Shell-Skript in einem frischen, ressourcenbegrenzten Sibling-
/// Container aus, der NUR EIN Arbeitsverzeichnis im geteilten Workspace-
/// Volume sieht – normalerweise das Hauptverzeichnis eines Projekts, bei
/// einem parallel laufenden Ticket (siehe worker/ticketWorktree.ts) dessen
/// eigenes Git-Worktree-Geschwisterverzeichnis. Grundlage für die
/// automatischen Prüfungen unten UND für das `run_command`-Werkzeug des
/// Umsetzer-Agenten (siehe worker/agentTools.ts).
///
/// Bewusst `--mount ... volume-subpath=<workspaceSubpath>` statt
/// `-v volume:/workspaces` mit anschliessendem `cd` im Skript: Bei den
/// Prüfungen unten ist der `cd`-Zielpfad zwar serverseitig fest, aber
/// `run_command` fuehrt MODELLGENERIERTE Befehle aus. Ein "cd .." oder "ls
/// /workspaces" waere ohne den Subpath-Mount ein Mandanten-uebergreifendes
/// Datenleck – mit ihm sieht der Container strukturell nur noch das
/// angegebene Verzeichnis als "/", unabhaengig davon, was der Befehl tut.
/// `workspaceSubpath` muss deshalb IMMER ein direktes Kindverzeichnis der
/// Volume-Wurzel sein (Projekt-ID oder `<projektId>__wt__<ticketId>`), nie
/// ein tieferer, zusammengesetzter Pfad. Braucht Docker >= 24.
export async function runInSandbox(
  workspaceSubpath: string,
  script: string,
  {
    containerNamePrefix = "scrumy-run",
    timeoutMs = 120_000,
    memory = "1g",
    cpus = "2",
    pidsLimit = "512",
    maxOutputChars = 8000,
    signal,
  }: {
    containerNamePrefix?: string;
    timeoutMs?: number;
    memory?: string;
    cpus?: string;
    pidsLimit?: string;
    maxOutputChars?: number;
    /** Von Hand ausgeloester Abbruch (siehe worker/cancellation.ts) – toetet
     *  den Container sofort, statt auf `timeoutMs` zu warten. */
    signal?: AbortSignal;
  } = {},
): Promise<{ exitCode: number | null; timedOut: boolean; unavailable: boolean; output: string }> {
  const containerName = `${containerNamePrefix}-${workspaceSubpath}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);

  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--mount",
    `type=volume,source=${testRunnerVolume()},target=/workspaces,volume-subpath=${workspaceSubpath}`,
    "--memory",
    memory,
    "--cpus",
    cpus,
    "--pids-limit",
    pidsLimit,
    "-w",
    "/workspaces",
    // CI=true bringt praktisch jeden JS-Testrunner (vitest, jest, CRA/react-
    // scripts, …) dazu, einmal durchzulaufen statt in den Watch-Modus zu
    // gehen. Ohne das hängt z.B. "npm test" (→ vitest ohne --run) den
    // gesamten Container auf, s.u. – das war real der Grund, warum ein
    // Agenten-Ticket-Job nie fertig wurde und die komplette Job-Queue dieses
    // Agenten blockiert hat.
    "-e",
    "CI=true",
    "--entrypoint",
    "sh",
    testRunnerImage(),
    "-c",
    script,
  ];

  // Zweite Absicherung GEGEN genau diesen Fall (falsch konfiguriertes
  // Skript startet trotzdem einen Dauerprozess, z.B. "npm start"): Der
  // execFile-"timeout" oben killt nur den lokalen "docker"-CLI-Prozess per
  // SIGTERM. Bei "docker run" (angehängt, ohne -d) hängt die Ausgabe- und
  // Exit-Weiterleitung des CLI aber am tatsächlichen Container-Ende – bei
  // Pipelines ("... | tail") oder ignoriertem SIGTERM in der Shell kommt das
  // Signal nie beim eigentlichen Kindprozess an, der CLI-Prozess (und damit
  // unser await) bleibt für immer hängen, obwohl "timeout" "gefeuert" hat.
  // Deshalb zusätzlich direkt beim Docker-Daemon killen – das ist vom
  // Zustand des lokalen CLI-Prozesses unabhängig und beendet den Container
  // zuverlässig, --rm räumt ihn danach weg.
  const hardKillTimer = setTimeout(() => {
    execFile("docker", ["kill", containerName], () => {
      // Bestmöglicher Versuch – wenn der Container schon weg ist, ist das ok.
    });
  }, timeoutMs + 2_000);

  // Von Hand abgebrochen (siehe `signal`, worker/cancellation.ts): denselben
  // Direkt-beim-Daemon-Kill wie oben sofort auslösen, statt bis zum ohnehin
  // gesetzten Zeitlimit zu warten – ein Mensch, der auf "Stopp" klickt,
  // erwartet kein Warten auf `timeoutMs`.
  const onCancel = () => {
    execFile("docker", ["kill", containerName], () => {});
  };
  signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { exitCode: 0, timedOut: false, unavailable: false, output: clipOutput(`${stdout}\n${stderr}`.trim(), maxOutputChars) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: number };
    if (err.code === "ENOENT" || (!("stdout" in err) && !("stderr" in err))) {
      return { exitCode: null, timedOut: false, unavailable: true, output: err.message ?? String(error) };
    }
    const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    return {
      exitCode: typeof err.code === "number" ? err.code : null,
      timedOut: Boolean(err.killed),
      unavailable: false,
      output: clipOutput(combined || (err.message ?? String(error)), maxOutputChars),
    };
  } finally {
    clearTimeout(hardKillTimer);
    signal?.removeEventListener("abort", onCancel);
  }
}

/// Die Skripte, die als Nachweis zählen – in dieser Reihenfolge ausgeführt.
/// Absichtlich nur diese drei, konventionellen Namen: Scrumys eigene
/// Grundregeln erzwingen keinen Techstack, aber "test"/"lint"/"build" sind der
/// Quasi-Standard jedes package.json, auf den sich verlassen lässt, ohne
/// projektspezifisch zu raten.
const CHECK_SCRIPTS = ["test", "lint", "build"] as const;
type CheckScript = (typeof CHECK_SCRIPTS)[number];

export interface CheckTarget {
  /// Verzeichnis relativ zur Repo-Wurzel, "." für die Wurzel selbst.
  relDir: string;
  scripts: CheckScript[];
}

/// Findet jedes package.json im Repo mit mindestens einem der Prüf-Skripte.
/// Bewusst über die tatsächlich vorhandenen Dateien (git-getrackt) statt über
/// geratene Verzeichnisnamen wie "backend"/"frontend": beim Docker-Compose-
/// Zuschnitt aus den Grundregeln hat jeder Dienst sein eigenes package.json,
/// wo genau es liegt, entscheidet das Team, nicht Scrumy.
export async function detectCheckTargets(dir: string, maxTargets = 6): Promise<CheckTarget[]> {
  const files = await listTrackedFiles(dir);
  const packageFiles = files.filter(
    (file) => path.basename(file) === "package.json" && !file.split("/").includes("node_modules"),
  );

  const targets: CheckTarget[] = [];
  for (const file of packageFiles) {
    const content = await readRepoFile(dir, file);
    if (!content) continue;
    let parsed: { scripts?: Record<string, unknown> };
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    const scripts = CHECK_SCRIPTS.filter((name) => typeof parsed.scripts?.[name] === "string");
    if (scripts.length === 0) continue;
    targets.push({ relDir: path.dirname(file), scripts });
    if (targets.length >= maxTargets) break;
  }
  return targets;
}

export interface CheckRunResult {
  relDir: string;
  scripts: CheckScript[];
  installExitCode: number | null;
  scriptExitCodes: Partial<Record<CheckScript, number>>;
  timedOut: boolean;
  /// true, wenn Docker/der Runner selbst nicht erreichbar war – kein Befund
  /// über das Projekt, sondern eine Infrastrukturlücke. Wird separat
  /// ausgewiesen, damit QA das nicht mit einem Mangel im Code verwechselt.
  unavailable: boolean;
  output: string;
}

const MARKER = "__SCRUMY_CHECK__";
const MARKER_RE = new RegExp(`${MARKER} (\\w+) exit=(-?\\d+)`, "g");

function parseMarkers(raw: string): { installExitCode: number | null; scriptExitCodes: Partial<Record<CheckScript, number>> } {
  let installExitCode: number | null = null;
  const scriptExitCodes: Partial<Record<CheckScript, number>> = {};
  for (const match of raw.matchAll(MARKER_RE)) {
    const [, name, code] = match;
    if (name === "install") installExitCode = Number(code);
    else if ((CHECK_SCRIPTS as readonly string[]).includes(name)) {
      scriptExitCodes[name as CheckScript] = Number(code);
    }
  }
  return { installExitCode, scriptExitCodes };
}

function clipOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Der interessante Teil eines fehlgeschlagenen Laufs steht fast immer am
  // Ende (der Fehler, nicht das Install-Log davor) – deshalb vom Ende her
  // kappen, nicht vom Anfang.
  return `… (${text.length - maxChars} Zeichen gekürzt)\n${text.slice(-maxChars)}`;
}

/// Führt "npm ci" (oder "npm install", falls kein Lockfile vorliegt) gefolgt
/// von jedem vorhandenen Prüf-Skript in einem frischen, ressourcenbegrenzten
/// Container aus – für jedes Ziel einen eigenen Lauf, damit ein hängender
/// Test die anderen Ziele nicht blockiert.
export async function runChecks(
  workspaceSubpath: string,
  targets: CheckTarget[],
  { timeoutMs = 480_000, maxOutputChars = 8000 } = {},
): Promise<CheckRunResult[]> {
  const results: CheckRunResult[] = [];
  for (const target of targets) {
    results.push(await runSingleCheck(workspaceSubpath, target, timeoutMs, maxOutputChars));
  }
  return results;
}

async function runSingleCheck(
  workspaceSubpath: string,
  target: CheckTarget,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<CheckRunResult> {
  // Dank Subpath-Mount (siehe runInSandbox) ist "/workspaces" im Container
  // bereits die Projektwurzel – hier nur noch relDir anhängen.
  const workdir = target.relDir === "." ? "/workspaces" : path.posix.join("/workspaces", target.relDir);
  const script = [
    `cd "${workdir}" || { echo "${MARKER} install exit=97"; exit 97; }`,
    `if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi`,
    `install_ec=$?`,
    `echo "${MARKER} install exit=$install_ec"`,
    `if [ "$install_ec" -ne 0 ]; then exit "$install_ec"; fi`,
    ...target.scripts.map((name) => `npm run ${name} --if-present; echo "${MARKER} ${name} exit=$?"`),
  ].join("\n");

  const run = await runInSandbox(workspaceSubpath, script, {
    containerNamePrefix: `scrumy-check-${target.relDir.replace(/[^a-zA-Z0-9_-]/g, "_") || "root"}`,
    timeoutMs,
    maxOutputChars,
  });
  const { installExitCode, scriptExitCodes } = parseMarkers(run.output);
  return {
    relDir: target.relDir,
    scripts: target.scripts,
    installExitCode,
    scriptExitCodes,
    timedOut: run.timedOut,
    unavailable: run.unavailable,
    output: run.output,
  };
}

export function checkFailed(result: CheckRunResult): boolean {
  if (result.unavailable) return false;
  if (result.installExitCode !== null && result.installExitCode !== 0) return true;
  return result.scripts.some((name) => (result.scriptExitCodes[name] ?? 0) !== 0);
}

/// Menschenlesbare Zusammenfassung für Modell-Prompts und die Dokumentation
/// im Repo (docs/technik/…) – ein Ziel pro Abschnitt, mit den echten
/// Exit-Codes und dem (gekürzten) Log.
export function formatCheckResults(results: CheckRunResult[]): string {
  if (results.length === 0) {
    return "(kein package.json mit test-/lint-/build-Skript im Repository gefunden – keine automatische Prüfung möglich)";
  }
  return results
    .map((result) => {
      const label = result.relDir === "." ? "Repository-Wurzel" : result.relDir;
      if (result.unavailable) {
        return `### ${label}\nAutomatische Prüfung technisch nicht verfügbar: ${result.output}`;
      }
      const installLine = `npm ci/install: exit ${result.installExitCode ?? "?"}`;
      const scriptLines = result.scripts
        .map((name) => `npm run ${name}: exit ${result.scriptExitCodes[name] ?? "(nicht erreicht)"}`)
        .join("\n");
      const status = result.timedOut ? "\n⚠ Zeitlimit erreicht, Lauf abgebrochen." : "";
      return `### ${label}\n${installLine}\n${scriptLines}${status}\n\nAusgabe:\n\`\`\`\n${result.output}\n\`\`\``;
    })
    .join("\n\n");
}
