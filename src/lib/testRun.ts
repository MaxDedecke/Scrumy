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

function testRunnerImage(): string {
  return process.env.TEST_RUNNER_IMAGE || process.env.PREVIEW_RUNNER_IMAGE || "scrumy-preview-runner";
}
function testRunnerVolume(): string {
  return process.env.TEST_RUNNER_WORKSPACE_VOLUME || process.env.PREVIEW_WORKSPACE_VOLUME || "scrumy_scrumy_workspaces";
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
  projectId: string,
  targets: CheckTarget[],
  { timeoutMs = 480_000, maxOutputChars = 8000 } = {},
): Promise<CheckRunResult[]> {
  const results: CheckRunResult[] = [];
  for (const target of targets) {
    results.push(await runSingleCheck(projectId, target, timeoutMs, maxOutputChars));
  }
  return results;
}

async function runSingleCheck(
  projectId: string,
  target: CheckTarget,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<CheckRunResult> {
  const workdir = path.posix.join("/workspaces", projectId, target.relDir === "." ? "" : target.relDir);
  const script = [
    `cd "${workdir}" || { echo "${MARKER} install exit=97"; exit 97; }`,
    `if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi`,
    `install_ec=$?`,
    `echo "${MARKER} install exit=$install_ec"`,
    `if [ "$install_ec" -ne 0 ]; then exit "$install_ec"; fi`,
    ...target.scripts.map((name) => `npm run ${name} --if-present; echo "${MARKER} ${name} exit=$?"`),
  ].join("\n");

  const containerName =
    `scrumy-check-${projectId}-${target.relDir.replace(/[^a-zA-Z0-9_-]/g, "_") || "root"}-${Date.now()}`.slice(0, 128);

  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-v",
    `${testRunnerVolume()}:/workspaces`,
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--pids-limit",
    "512",
    "--entrypoint",
    "sh",
    testRunnerImage(),
    "-c",
    script,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    const { installExitCode, scriptExitCodes } = parseMarkers(combined);
    return {
      relDir: target.relDir,
      scripts: target.scripts,
      installExitCode,
      scriptExitCodes,
      timedOut: false,
      unavailable: false,
      output: clipOutput(combined, maxOutputChars),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: number };
    // "docker" selbst fehlt/antwortet nicht (kein Socket gemountet, Runner-
    // Image nicht gebaut, …) – das ist keine Aussage über das Projekt.
    if (err.code === "ENOENT" || (!("stdout" in err) && !("stderr" in err))) {
      return {
        relDir: target.relDir,
        scripts: target.scripts,
        installExitCode: null,
        scriptExitCodes: {},
        timedOut: false,
        unavailable: true,
        output: err.message ?? String(error),
      };
    }
    const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    const { installExitCode, scriptExitCodes } = parseMarkers(combined);
    // Aufgeräumt bleiben lassen: bei Timeout raeumt "--rm" den Container erst
    // beim (durch das Signal ausgeloesten) Beenden weg, das passiert von
    // selbst – kein zusaetzliches "docker rm -f" noetig.
    return {
      relDir: target.relDir,
      scripts: target.scripts,
      installExitCode,
      scriptExitCodes,
      timedOut: Boolean(err.killed),
      unavailable: false,
      output: clipOutput(combined || (err.message ?? String(error)), maxOutputChars),
    };
  }
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
