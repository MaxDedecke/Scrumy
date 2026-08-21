// Git-Worktrees für parallel laufende Tickets – das Gegenstück zum
// Hauptverzeichnis eines Projekts (siehe src/lib/workspace.ts).
//
// Warum ein eigenes Verzeichnis statt einfach im selben Arbeitsverzeichnis
// weiterzuarbeiten: `withWorkspaceLock` (worker/workspaceLock.ts) sperrt pro
// Verzeichnis – zwei Tickets im selben Verzeichnis liefen deshalb trotz
// PARALLEL-Modus strikt nacheinander (siehe [[scrumy-projekt]]-Memory). Ein
// eigenes Git-Worktree (eigener Branch, eigenes Arbeitsverzeichnis, dasselbe
// Repository) macht den Lock automatisch wirkungslos gegeneinander: nur der
// kurze Übernahme-Schritt am Ende (Merge in den Hauptbranch + Push) sperrt
// noch das Hauptverzeichnis, nicht mehr die ganze Ticket-Laufzeit.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { agentForRole } from "@/lib/team";
import { MergeConflictError, readRepoFile, runGitCommand, pushRepo, workspaceRoot } from "@/lib/workspace";
import { runImplementationLoop } from "./agentToolLoop";
import { TEAM_GRUNDREGELN } from "./projectContext";
import { withWorkspaceLock } from "./workspaceLock";

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (gekürzt)` : text;
}

function ticketBranch(ticketId: string): string {
  return `ticket/${ticketId}`;
}

/// Geschwisterverzeichnis von `workspacePathFor(projectId)`, NICHT darunter
/// verschachtelt: Ein `git status`/`git add -A` im Hauptverzeichnis (von
/// einem dort gerade laufenden Ticket) würde ein verschachteltes Worktree
/// sonst als fremden, unversionierten Ordner sehen. Der Name ist zugleich der
/// Docker-Volume-Subpath für die Sandbox eines darin laufenden `run_command`
/// (siehe src/lib/testRun.ts) – muss also ein direktes Kindverzeichnis der
/// Volume-Wurzel bleiben.
export function worktreePathFor(projectId: string, ticketId: string): string {
  return path.join(workspaceRoot(), `${projectId}__wt__${ticketId}`);
}

async function conflictedFiles(dir: string): Promise<string[]> {
  return (await runGitCommand(dir, ["diff", "--name-only", "--diff-filter=U"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/// Legt, falls noch nicht vorhanden, ein Worktree für dieses Ticket an – ein
/// neuer Branch vom aktuellen Stand des Hauptverzeichnisses. Idempotent: Ein
/// erneuter Aufruf (z.B. nach einem Worker-Neustart mitten im ersten Anlauf)
/// legt nichts doppelt an, sondern gibt den vorhandenen Pfad zurück.
export async function createTicketWorktree(mainDir: string, projectId: string, ticketId: string): Promise<string> {
  const dir = worktreePathFor(projectId, ticketId);
  const branch = ticketBranch(ticketId);

  await withWorkspaceLock(mainDir, async () => {
    const existing = await runGitCommand(mainDir, ["worktree", "list", "--porcelain"]).catch(() => "");
    if (existing.includes(`worktree ${dir}\n`)) return;

    const base = await runGitCommand(mainDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((out) => out.trim());
    await mkdir(path.dirname(dir), { recursive: true });
    await runGitCommand(mainDir, ["worktree", "add", dir, "-b", branch, base]);
  });

  return dir;
}

/// Lässt denselben Umsetzer-Agenten die Konflikte eines gerade gescheiterten
/// Merges auflösen – wiederverwendet den bestehenden Werkzeug-Loop
/// (worker/agentToolLoop.ts) mit einem engen Auftrag statt einer neuen
/// Konflikt-Loop-Implementierung. `dir` ist dabei das HAUPTverzeichnis (dort
/// steht der Merge gerade mitten drin), nicht das Worktree des Tickets.
async function resolveMergeConflicts(input: {
  dir: string;
  agent: Agent;
  projectId: string;
  ticketId: string;
  ticketTitle: string;
}): Promise<boolean> {
  const { dir, agent, projectId, ticketId, ticketTitle } = input;
  const files = await conflictedFiles(dir);
  if (files.length === 0) return true;

  const fileBlocks = await Promise.all(
    files.slice(0, 12).map(async (file) => {
      const content = (await readRepoFile(dir, file)) ?? "(Datei konnte nicht gelesen werden)";
      return `### ${file}\n\`\`\`\n${clip(content, 4000)}\n\`\`\``;
    }),
  );

  const loopResult = await runImplementationLoop({
    agent,
    projectId,
    dir,
    // Konfliktauflösung passiert immer im Hauptverzeichnis – dessen
    // Sandbox-Subpath ist die Projekt-ID selbst.
    workspaceSubpath: projectId,
    ticketId,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}. Ein Kollegen-Zweig wurde soeben parallel in den Hauptbranch gemergt, dabei sind Git-Merge-Konflikte entstanden. Löse AUSSCHLIESSLICH diese Konflikte auf – entferne die Konfliktmarker (<<<<<<<, =======, >>>>>>>) und behalte dabei den inhaltlich richtigen, vollständigen Stand aus beiden Seiten. Ändere sonst NICHTS. Ruf "finish" auf, sobald in jeder betroffenen Datei keine Konfliktmarkierung mehr steht.`,
    initialPrompt: `## Ticket, dessen Zweig gerade gemergt wurde
„${ticketTitle}"

## Konfliktbehaftete Dateien (aktueller Inhalt mit Konfliktmarkern)
${fileBlocks.join("\n\n")}

Lies bei Bedarf mit read_file den vollständigen aktuellen Inhalt einer Datei, entferne die Konfliktmarker mit edit_file/write_file und behalte dabei beide Absichten, wo sie sich nicht wirklich widersprechen. Führe danach mit run_command sinnvolle Tests aus, wenn welche existieren. Ruf zuletzt "finish" auf – "commitMessage" und "summary" dürfen hier kurz ausfallen, es wird kein eigener Commit daraus.`,
    maxTokensPerTurn: 4000,
  });

  return loopResult.finished && (await conflictedFiles(dir)).length === 0;
}

/// Schließt einen laufenden, konfliktbehafteten `git merge`/`git pull`-Vorgang
/// im Hauptverzeichnis ab, nachdem `resolveMergeConflicts` die Marker entfernt
/// hat. Kein neuer Commit-Text nötig: Git hat die Merge-Message bereits in
/// `.git/MERGE_MSG` hinterlegt.
async function commitResolvedMerge(dir: string, agent: Agent): Promise<void> {
  const email = `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "agent"}@agents.scrumy.local`;
  await runGitCommand(dir, ["add", "-A"]);
  await runGitCommand(dir, ["-c", `user.name=${agent.name}`, "-c", `user.email=${email}`, "commit", "--no-edit"]);
}

/// Übernimmt den fertigen Ticket-Branch in den Hauptbranch: mergen (bei
/// Konflikt: derselbe Agent löst sie auf), pushen, danach das Worktree
/// abbauen. Läuft komplett unter `withWorkspaceLock(mainDir, …)` – das ist
/// jetzt bewusst der EINZIGE Moment, in dem das Hauptverzeichnis für dieses
/// Ticket gesperrt wird, nicht mehr seine ganze Laufzeit.
///
/// Wirft `MergeConflictError`, wenn auch der Agent den Konflikt nicht
/// auflösen konnte – der Aufrufer (`integrateAndFinalizeTicket`) fängt das ab
/// und behandelt es wie jeden anderen gescheiterten Anlauf. Der Ticket-Branch
/// und sein Worktree bleiben in diesem Fall bestehen, der nächste Anlauf baut
/// direkt darauf auf.
export async function integrateTicketWorktree(input: {
  mainDir: string;
  worktreeDir: string;
  ticketId: string;
  ticketTitle: string;
  agent: Agent;
  projectId: string;
}): Promise<void> {
  const { mainDir, worktreeDir, ticketId, ticketTitle, agent, projectId } = input;
  const branch = ticketBranch(ticketId);

  await withWorkspaceLock(mainDir, async () => {
    try {
      await runGitCommand(mainDir, ["merge", "--no-ff", branch, "-m", `Merge: ${ticketTitle}`]);
    } catch (mergeError) {
      const conflictsNow = await conflictedFiles(mainDir);
      if (conflictsNow.length === 0) {
        // Kein inhaltlicher Konflikt (z.B. Branch fehlt, defektes Repo) – das
        // kann kein Agent "lösen", also nicht erst versuchen.
        await runGitCommand(mainDir, ["merge", "--abort"]).catch(() => {});
        throw mergeError instanceof Error ? mergeError : new Error(String(mergeError));
      }
      const resolved = await resolveMergeConflicts({ dir: mainDir, agent, projectId, ticketId, ticketTitle });
      if (!resolved) {
        await runGitCommand(mainDir, ["merge", "--abort"]).catch(() => {});
        throw new MergeConflictError(
          `Konnte den Branch von „${ticketTitle}" nicht automatisch mit dem Hauptbranch zusammenführen – der Konflikt blieb auch nach einem Lösungsversuch von ${agent.name} bestehen.`,
          await conflictedFiles(mainDir),
        );
      }
      await commitResolvedMerge(mainDir, agent);
    }

    try {
      await pushRepo(mainDir);
    } catch (error) {
      // Derselbe Konfliktfall, nur diesmal gegen `origin` statt gegen den
      // Ticket-Branch (siehe pushRepo in src/lib/workspace.ts) – derselbe
      // Agent, derselbe Lösungsweg.
      if (!(error instanceof MergeConflictError)) throw error;
      const resolved = await resolveMergeConflicts({ dir: mainDir, agent, projectId, ticketId, ticketTitle });
      if (!resolved) {
        await runGitCommand(mainDir, ["merge", "--abort"]).catch(() => {});
        throw error;
      }
      await commitResolvedMerge(mainDir, agent);
      await pushRepo(mainDir);
    }

    await runGitCommand(mainDir, ["worktree", "remove", worktreeDir, "--force"]).catch(() => {});
    await runGitCommand(mainDir, ["branch", "-d", branch]).catch(() => {});
  });
}

/// Der eine Weg, ein Ticket als DONE abzuschließen – egal ob direkt aus
/// worker/tasks/ticketWork.ts (automatische Prüfung, QA-Freigabe) oder aus
/// src/lib/reviewDecision.ts (menschliche/PO-Freigabe nach `requestHumanReview`).
/// Beide Wege müssen dasselbe tun: Lief das Ticket in einem eigenen Worktree,
/// erst in den Hauptbranch übernehmen – sonst würde ein Sprint-Review oder ein
/// weiteres Ticket auf einem Hauptverzeichnis aufsetzen, dem die Arbeit dieses
/// Tickets noch fehlt.
///
/// Gibt bei einem nicht auflösbaren Konflikt `{ ok: false }` zurück (KEIN
/// Wurf) und lässt den Ticket-Status bewusst unverändert – der Aufrufer
/// entscheidet dann selbst, wie er das Ticket zurück in die Nacharbeit
/// schickt (siehe die Call-Sites).
export async function integrateAndFinalizeTicket(input: {
  ticketId: string;
  projectId: string;
  /// Zusätzliche Felder für das Ticket-Update, z.B. `{ result: "..." }`.
  extraData?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ticketId, projectId, extraData } = input;
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  if (ticket.worktreePath) {
    if (!project.workspacePath) {
      return { ok: false, error: "Kein Arbeitsverzeichnis für das Projekt vorhanden." };
    }
    const agent =
      (ticket.assigneeId ? await prisma.agent.findUnique({ where: { id: ticket.assigneeId } }) : null) ??
      (await agentForRole(projectId, "BACKEND"));
    if (!agent) return { ok: false, error: "Niemand im Team konnte den Ticket-Zweig übernehmen." };

    try {
      await integrateTicketWorktree({
        mainDir: project.workspacePath,
        worktreeDir: ticket.worktreePath,
        ticketId,
        ticketTitle: ticket.title,
        agent,
        projectId,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "DONE", worktreePath: null, ...(extraData ?? {}) },
  });
  return { ok: true };
}
