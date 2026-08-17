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
    return { dir, created: true };
  }
}

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

/// Kurzer Repo-Ueberblick fuer Agenten-Prompts: Dateibaum plus die letzten
/// Commit-Betreffzeilen. Bewusst knapp – der Prompt soll das Modell
/// orientieren, nicht das ganze Repo einbetten.
export async function repoOverview(dir: string, maxFiles = 120): Promise<string> {
  const [files, log] = await Promise.all([listTrackedFiles(dir), gitLog(dir, 10)]);

  const fileList = files.length === 0
    ? "(noch leer)"
    : files.slice(0, maxFiles).join("\n") +
      (files.length > maxFiles ? `\n… und ${files.length - maxFiles} weitere Dateien` : "");

  const history = log.length === 0
    ? "(noch keine Commits)"
    : log.map((c) => `${c.shortSha} ${c.author}: ${c.subject}`).join("\n");

  return `Dateien im Repository:\n${fileList}\n\nLetzte Commits:\n${history}`;
}
