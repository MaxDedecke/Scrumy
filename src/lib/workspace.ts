// Der Arbeitsplatz des Agenten-Teams: pro Projekt ein echtes lokales Git-Repo.
//
// Warum Git und nicht "Dateien in der DB": Die Agenten sollen wie Kollegen
// arbeiten, und die Nachvollziehbarkeit ihrer Arbeit ist genau das, was Git
// kann – wer hat wann was geaendert, mit Begruendung in der Commit-Message und
// einem Diff dazu. Der Audit-Trail in der Datenbank (`AgentRun`) erklaert das
// WARUM (Prompt + Antwort des Modells), das Repo zeigt das WAS.
//
// Das Verzeichnis liegt im Workspace-Volume (siehe docker-compose.yml), das
// sich `app` und `worker` teilen: Der Worker schreibt (Agenten committen), die
// App liest (Commit-Historie und Diffs in der Oberflaeche).
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/// Absichtlich ohne Shell (`execFile`, kein `exec`): Commit-Messages und
/// Dateinamen kommen aus Modellantworten und duerfen niemals als Shell-Code
/// interpretiert werden.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      // Reproduzierbar und ohne Rueckfragen: keine globale Git-Config, kein
      // Editor, keine Hooks aus dem Elternverzeichnis.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

export function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || path.join(process.cwd(), ".workspaces");
}

export function workspacePathFor(projectId: string): string {
  // `turbopackIgnore`: Der Build analysiert Dateizugriffe statisch und wuerde
  // sonst das gesamte Projekt in die Server-Ausgabe kopieren. Der Pfad zeigt
  // zur Laufzeit ins Workspace-Volume, nie in den Quellbaum.
  return path.join(/* turbopackIgnore: true */ workspaceRoot(), projectId);
}

/// Legt das Repo an, falls es noch nicht existiert, und gibt seinen Pfad
/// zurueck. Idempotent – ein zweiter Team-Start loescht keine Arbeit.
export async function ensureRepo(projectId: string): Promise<{ dir: string; created: boolean }> {
  const dir = workspacePathFor(projectId);
  await mkdir(dir, { recursive: true });

  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    return { dir, created: false };
  } catch {
    await git(dir, ["init", "--initial-branch=main"]);
    // Identitaet setzen wir pro Commit (der jeweilige Agent ist der Autor),
    // hier nur das, was fuer jeden Commit gleich gilt.
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(dir, ".gitignore"), DEFAULT_GITIGNORE, "utf8");
    await commitAll(dir, { message: "Repository eingerichtet", authorName: "Scrumy" });
    return { dir, created: true };
  }
}

/// Ohne das landet der erste `npm install` eines Umsetzer-Agenten (via
/// run_command, siehe worker/agentTools.ts) komplett in Git: node_modules
/// hat leicht zehntausende Dateien, und jeder folgende `git status`/`git
/// add -A`/`git ls-files` (list_files, commitAll, ...) muss sie durchwühlen
/// – bis ein Kommando das 20MB-Ausgabelimit reißt und den ganzen Job crasht
/// (siehe git() unten), statt nur den Ticket-Versuch fehlschlagen zu lassen.
/// Beobachtet im OnwPhoto-Projekt: 2236 committete node_modules-Dateien,
/// danach ein toter Worker-Job ohne jede sichtbare Fehlermeldung am Ticket.
const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
.next/
out/
coverage/
.env
.env.*
*.log
.DS_Store
`;

/// Loescht das Arbeitsverzeichnis eines Projekts mitsamt der Software, die das
/// Team dort gebaut hat. Gegenstueck zu `ensureRepo` – wird ein Projekt
/// geloescht, darf sein Code nicht im Volume weiterleben: er enthaelt
/// Kundenanforderungen und Modellausgaben, und ein spaeteres Projekt mit
/// derselben ID (Restore eines DB-Dumps) wuerde auf fremder Arbeit aufsetzen.
///
/// `storedPath` ist der in der DB vermerkte Pfad. Er wird zusaetzlich zum
/// berechneten Pfad beruecksichtigt, damit auch Repos verschwinden, die unter
/// einem frueheren `WORKSPACE_ROOT` angelegt wurden. Beide Kandidaten muessen
/// auf die Projekt-ID enden – ein verrutschter oder manipulierter Wert in der
/// Datenbank soll niemals ein beliebiges Verzeichnis loeschen koennen.
export async function removeWorkspace(projectId: string, storedPath?: string | null): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new WorkspaceError(`Ungueltige Projekt-ID: ${projectId}`);
  }

  const targets = new Set<string>([workspacePathFor(projectId)]);
  if (storedPath && path.isAbsolute(storedPath) && path.basename(storedPath) === projectId) {
    targets.add(path.resolve(storedPath));
  }

  for (const target of targets) {
    // `force`: Ein Projekt, an dem nie ein Team gearbeitet hat, hat kein
    // Verzeichnis – das ist kein Fehlerfall.
    await rm(target, { recursive: true, force: true });
  }
}

/// Die Projekt-IDs aller Verzeichnisse im Workspace-Volume. Grundlage fuer das
/// Aufraeumen verwaister Repos (siehe worker/reconcile.ts).
export async function listWorkspaceProjectIds(): Promise<string[]> {
  try {
    // `turbopackIgnore` wie in `workspacePathFor`: Der Build analysiert
    // Dateizugriffe statisch und wuerde sonst den gesamten Quellbaum in die
    // Server-Ausgabe kopieren. Gelesen wird zur Laufzeit nur das Volume.
    const entries = await readdir(/* turbopackIgnore: true */ workspaceRoot(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // Volume noch nicht angelegt: dann gibt es auch nichts aufzuraeumen.
    return [];
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/// Prueft einen von einem Modell gelieferten Dateipfad, bevor irgendetwas
/// geschrieben wird: nur relative Pfade innerhalb des Repos, kein `.git`.
/// Ein Modell, das sich vertut oder eine manipulierte Anforderung umsetzt,
/// soll hoechstens im Projektverzeichnis Unsinn anstellen.
export function safeRepoPath(dir: string, relativePath: string): string {
  const cleaned = relativePath.trim().replace(/^\.\//, "");
  if (!cleaned) throw new WorkspaceError("Leerer Dateipfad.");
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
    throw new WorkspaceError(`Absoluter Pfad nicht erlaubt: ${relativePath}`);
  }

  const target = path.resolve(dir, cleaned);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new WorkspaceError(`Pfad zeigt aus dem Projektverzeichnis heraus: ${relativePath}`);
  }
  if (path.relative(root, target).split(path.sep)[0] === ".git") {
    throw new WorkspaceError("Schreiben in .git ist nicht erlaubt.");
  }
  return target;
}

export interface FileChange {
  path: string;
  content: string;
}

/// Schreibt die Dateien einer Agenten-Antwort ins Repo. Erst alle Pfade
/// pruefen, dann schreiben – sonst bliebe bei einem faulen Pfad ein halb
/// angewendeter Stand liegen.
export async function writeFiles(dir: string, changes: FileChange[]): Promise<string[]> {
  const targets = changes.map((change) => ({ ...change, target: safeRepoPath(dir, change.path) }));

  for (const { target, content } of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  return targets.map((t) => path.relative(dir, t.target));
}

/// Trennt zulaessige von unzulaessigen Pfaden, statt beim ersten faulen Pfad
/// alles hinzuwerfen. Ein Agent, der neben zehn guten Dateien einen absoluten
/// Pfad liefert, soll die zehn guten trotzdem loswerden – der Rest steht
/// nachvollziehbar im Protokoll.
export function partitionSafeChanges(
  dir: string,
  changes: FileChange[],
): { accepted: FileChange[]; rejected: { path: string; reason: string }[] } {
  const accepted: FileChange[] = [];
  const rejected: { path: string; reason: string }[] = [];

  for (const change of changes) {
    try {
      safeRepoPath(dir, change.path);
      accepted.push(change);
    } catch (error) {
      rejected.push({
        path: change.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { accepted, rejected };
}

export interface CommitResult {
  sha: string;
  shortSha: string;
  changedFiles: number;
}

/// Committet alles, was im Arbeitsverzeichnis liegt, im Namen eines Agenten.
/// Gibt `null` zurueck, wenn es nichts zu committen gab (ein Agent, der nichts
/// geaendert hat, soll keinen leeren Commit hinterlassen).
export async function commitAll(
  dir: string,
  { message, authorName }: { message: string; authorName: string },
): Promise<CommitResult | null> {
  await git(dir, ["add", "-A"]);

  const status = await git(dir, ["status", "--porcelain"]);
  const changedFiles = status.split("\n").filter((line) => line.trim().length > 0).length;
  if (changedFiles === 0) return null;

  const email = `${slugForEmail(authorName)}@agents.scrumy.local`;
  await git(dir, [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    message,
  ]);

  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { sha, shortSha: sha.slice(0, 8), changedFiles };
}

/// Verwirft alles, was seit dem letzten Commit im Arbeitsverzeichnis liegt –
/// verfolgte Dateien werden zurückgesetzt, unverfolgte (neu angelegte)
/// entfernt. Gegenstück zu einem abgebrochenen Tool-Loop (siehe
/// worker/agentToolLoop.ts): Bricht die Umsetzung ohne `finish`-Aufruf ab
/// (Turn- oder Zeitlimit erreicht), sollen angefangene Schreibvorgänge nicht
/// als halb fertiger Stand liegen bleiben, auf dem der naechste Anlauf
/// versehentlich aufbaut.
export async function discardUncommittedChanges(dir: string): Promise<void> {
  await git(dir, ["checkout", "--", "."]);
  await git(dir, ["clean", "-fd"]);
}

function slugForEmail(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return slug || "agent";
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  date: Date;
  subject: string;
  body: string;
  files: string[];
}

/// Liest die Commit-Historie fuer die Nachweis-Ansicht. Format bewusst mit
/// `%x1f`/`%x1e` (Unit/Record Separator) statt Komma-getrennt: Commit-Messages
/// der Agenten enthalten Zeilenumbrueche und Sonderzeichen.
export async function gitLog(dir: string, limit = 50): Promise<CommitInfo[]> {
  let raw: string;
  try {
    raw = await git(dir, [
      "log",
      `-${limit}`,
      "--name-only",
      "--date=iso-strict",
      "--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f",
    ]);
  } catch {
    // Frisches Repo ohne Commits: `git log` scheitert, das ist kein Fehler.
    return [];
  }

  return raw
    .split("\x1e")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, author, date, subject, body, fileBlock = ""] = record.split("\x1f");
      return {
        sha,
        shortSha: sha.slice(0, 8),
        author,
        date: new Date(date),
        subject,
        body: body.trim(),
        files: fileBlock
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      };
    });
}

/// Diff eines einzelnen Commits – die Belegebene fuer "zeig mir, was ihr
/// geaendert habt".
export async function gitShow(dir: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new WorkspaceError(`Ungueltiger Commit-Hash: ${sha}`);
  return git(dir, ["show", "--stat", "--patch", "--format=fuller", sha]);
}

/// Alle versionierten Dateien – als Kontext fuer die Agenten ("was gibt es
/// schon?") und fuer die Repo-Ansicht.
export async function listTrackedFiles(dir: string): Promise<string[]> {
  try {
    const raw = await git(dir, ["ls-files"]);
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function readRepoFile(dir: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(safeRepoPath(dir, relativePath), "utf8");
  } catch {
    return null;
  }
}

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".graphql", ".html", ".java", ".js", ".json",
  ".jsx", ".kt", ".md", ".php", ".prisma", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

/// Diese Pfade sind der eingefrorene Auftrag – Umsetzer duerfen sie nicht
/// aendern (siehe worker/tasks/ticketWork.ts) – UND stehen bereits vollstaendig
/// strukturiert im Projektkontext jedes Tickets (siehe worker/projectContext.ts,
/// Abschnitte „Freigegebenes Konzept"/„Freigegebene Anforderungen"). Sie
/// zusaetzlich als Rohtext in den Ticket-Prompt zu laden, verdoppelt nur den
/// Kontext, ohne neue Information zu liefern.
export const FROZEN_DOC_PATHS = [
  /^docs\/konzept\.md$/i,
  /^docs\/anforderungen\.md$/i,
  /^docs\/verstaendnis\.md$/i,
  /^docs\/sprints\//i,
];

export function isFrozenDocPath(file: string): boolean {
  const normalized = file.replace(/^\.\//, "");
  return FROZEN_DOC_PATHS.some((pattern) => pattern.test(normalized));
}

const QUERY_STOP_WORDS = new Set([
  "aber", "auch", "dass", "eine", "einem", "einen", "einer", "eines", "fuer", "implementieren", "mit",
  "oder", "soll", "ticket", "umsetzen", "und", "von", "werden", "wird", "with", "the", "this", "that",
]);

function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .replace(/[ä]/g, "ae")
      .replace(/[ö]/g, "oe")
      .replace(/[ü]/g, "ue")
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term)),
  )].slice(0, 40);
}

function scoreRepoPath(
  file: string,
  terms: string[],
  explicitlyMentioned: Set<string>,
  contentMatches: Set<string>,
): number {
  if (isFrozenDocPath(file)) return 0;
  const normalized = file.toLowerCase();
  let score = explicitlyMentioned.has(normalized) ? 1000 : 0;
  if (contentMatches.has(normalized)) score += 30;
  for (const term of terms) {
    if (normalized === term) score += 40;
    else if (normalized.includes(`/${term}.`) || normalized.startsWith(`${term}.`)) score += 20;
    else if (normalized.includes(term)) score += 6;
  }
  if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|readme\.md)$/i.test(file)) score += 2;
  if (/(^|\/)(test|tests|spec|specs)\//i.test(file) || /\.(test|spec)\./i.test(file)) score += 1;
  return score;
}

/**
 * Waehlt Dateien lokal nach Ticket, Plan und explizit genannten Pfaden aus.
 * Die Groesse des Repositories beeinflusst damit nur die billige Dateinamensuche,
 * nicht mehr die Promptgroesse.
 */
export async function relevantRepoFiles(dir: string, query: string, maxFiles = 18): Promise<string[]> {
  const files = (await listTrackedFiles(dir)).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const terms = queryTerms(query);
  const explicitlyMentioned = new Set(
    (query.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+/g) ?? [])
      .map((file) => file.replace(/^\.\//, "").toLowerCase()),
  );
  let contentMatches = new Set<string>();
  if (terms.length > 0) {
    try {
      // `git grep` durchsucht auch sehr große Repositories, ohne deren Inhalt
      // in Node oder in den Modellprompt zu laden. Einige prägnante Begriffe
      // genügen; der anschließende Pfad-Score bringt die Treffer in Reihenfolge.
      const raw = await git(dir, ["grep", "-I", "-l", "-i", ...terms.slice(0, 8).flatMap((term) => ["-e", term]), "--"]);
      contentMatches = new Set(raw.split("\n").map((file) => file.trim().toLowerCase()).filter(Boolean));
    } catch {
      // Keine Treffer liefert bei `git grep` Exit-Code 1 und ist kein Fehler.
    }
  }

  return files
    .map((file, index) => ({ file, index, score: scoreRepoPath(file, terms, explicitlyMentioned, contentMatches) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxFiles)
    .map((entry) => entry.file);
}

/// Volltextsuche fürs `search_files`-Werkzeug (worker/agentTools.ts): der
/// Agent sucht sich seinen Kontext selbst zusammen, statt ihn vorab
/// eingebettet zu bekommen. `git grep` durchsucht auch grosse Repositories,
/// ohne den Inhalt vorher nach Node zu laden.
export async function searchRepo(dir: string, query: string, maxLines = 60): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return "(leere Suchanfrage)";
  try {
    const raw = await git(dir, ["grep", "-n", "-I", "-i", "--", trimmed]);
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return "(keine Treffer)";
    const shown = lines.slice(0, maxLines);
    return shown.join("\n") + (lines.length > shown.length ? `\n… ${lines.length - shown.length} weitere Treffer` : "");
  } catch {
    // `git grep` liefert bei keinem Treffer Exit-Code 1 – kein Fehler.
    return "(keine Treffer)";
  }
}

export async function readRelevantSourceContext(
  dir: string,
  query: string,
  options: { maxChars?: number; maxFiles?: number } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 32_000;
  const selected = await relevantRepoFiles(dir, query, options.maxFiles ?? 18);
  if (selected.length === 0) return "(keine anhand des Tickets relevante Quelldatei gefunden)";

  const chunks: string[] = [];
  let used = 0;
  for (const file of selected) {
    const content = await readRepoFile(dir, file);
    if (content === null) continue;
    const header = `--- ${file} ---\n`;
    if (used + header.length + content.length > maxChars) {
      chunks.push(`--- ${file} (nicht geladen – Kontextbudget erreicht; bei Bedarf in einem kleineren Folgeticket bearbeiten) ---`);
      continue;
    }
    used += header.length + content.length;
    chunks.push(header + content);
  }
  return chunks.join("\n\n");
}

/// Kurzer Repo-Ueberblick fuer Agenten-Prompts: Dateibaum plus die letzten
/// Commit-Betreffzeilen. Bewusst knapp – der Prompt soll das Modell
/// orientieren, nicht das ganze Repo einbetten.
export async function repoOverview(dir: string, maxFiles = 120, query?: string): Promise<string> {
  const [files, log] = await Promise.all([listTrackedFiles(dir), gitLog(dir, 10)]);

  const shownFiles = query
    ? await relevantRepoFiles(dir, query, maxFiles)
    : files.slice(0, maxFiles);

  const fileList = files.length === 0
    ? "(noch leer)"
    : shownFiles.join("\n") +
      (files.length > shownFiles.length
        ? `\n… ${files.length - shownFiles.length} weitere Dateien sind vorhanden, aber für diesen Schritt nicht vorausgewählt`
        : "");

  const history = log.length === 0
    ? "(noch keine Commits)"
    : log.map((c) => `${c.shortSha} ${c.author}: ${c.subject}`).join("\n");

  return `Dateien im Repository:\n${fileList}\n\nLetzte Commits:\n${history}`;
}
