// Der Scrum Master prüft in regelmäßigen Abständen, ob neben dem gerade
// laufenden Ticket noch ein zweites, inhaltlich unabhängiges Ticket
// gefahrlos gleichzeitig bearbeitet werden kann – und startet es in einem
// eigenen Git-Worktree (siehe worker/ticketWorktree.ts), wenn ja.
//
// Das Gegenstück zum früheren, blinden "alle abholbaren Tickets auf einmal
// ziehen" (`Project.workMode = PARALLEL`, siehe worker/orchestration.ts,
// Kommentar an `nextOpenTicket`): Dort landeten mehrere Ticket-Jobs zwar
// gleichzeitig in der Queue, liefen im gemeinsamen Arbeitsverzeichnis aber
// trotzdem strikt nacheinander – der Modus brachte praktisch nichts (siehe
// [[scrumy-projekt]]-Memory). Hier entscheidet stattdessen ein echtes Urteil
// über inhaltliche Unabhängigkeit (andere Rolle, andere Bereiche), und erst
// danach bekommt das zusätzliche Ticket ein eigenes, wirklich paralleles
// Arbeitsverzeichnis.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { agentForRole } from "@/lib/team";
import { logActivity, runAgent } from "../agentRun";
import { TEAM_GRUNDREGELN } from "../projectContext";
import { loadWorkingProject, pullableTickets } from "../orchestration";
import { projectBlocker, sprintBlocker } from "../clarification";
import { activeTicketJobIds, enqueueAgentJob, enqueueDelayedAgentJob } from "../queue";
import { createTicketWorktree } from "../ticketWorktree";
import type { ParallelCheckPayload } from "../taskTypes";

/// Wie oft der Scrum Master nachsieht. Kein Kostentreiber (ein kurzer, guenstiger
/// JSON-Urteilsaufruf, und der auch nur, wenn ueberhaupt ein Kandidatenpaar
/// existiert) – aber auch keine Eile, ein Ticket braucht ohnehin Minuten, bis
/// ein zweites sinnvoll parallel dazu passt.
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/// Laufendes Ticket + hoechstens EIN zusaetzliches Worktree-Ticket – bewusst
/// knapp fuer die erste Ausbaustufe.
const MAX_PARALLEL_TICKETS = 2;

export async function scheduleParallelCheck(projectId: string, delayMs: number = CHECK_INTERVAL_MS): Promise<void> {
  const scrumMaster = await agentForRole(projectId, "SCRUM_MASTER");
  // Kein Scrum Master im Team: dann eben kein periodischer Check – die
  // Rollen-Vertretung (siehe src/lib/team.ts) gibt es hier bewusst nicht,
  // ein Product Owner, der sich selbst zur parallelen Arbeit "aufsichtigt",
  // waere kein zweiter Blick.
  if (!scrumMaster) return;
  await enqueueDelayedAgentJob(
    "parallelCheck",
    { agentId: scrumMaster.id, projectId, reason: "periodischer Parallel-Check" },
    { runAt: new Date(Date.now() + delayMs), jobKey: `parallelCheck:${projectId}` },
  );
}

const parallelCheck: Task<"parallelCheck"> = async (payload: ParallelCheckPayload, helpers) => {
  const { agentId, projectId } = payload;

  const project = await loadWorkingProject(projectId);
  if (!project || project.workMode !== "PARALLEL") {
    // Projekt inaktiv oder nicht mehr im Parallel-Modus: Die Kette endet hier
    // bewusst. `setWorkMode`/`sprintPlanning` stoßen sie bei Bedarf neu an.
    helpers.logger.info(`Projekt ${projectId}: Parallel-Check beendet (nicht aktiv oder nicht im Parallel-Modus).`);
    return;
  }

  try {
    await checkOnce(project.id, project.workspacePath, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Parallel-Check für Projekt ${projectId} fehlgeschlagen: ${message}`);
  } finally {
    // Bleibt das Projekt im Parallel-Modus, tickt der Check in JEDEM Fall
    // weiter – auch wenn dieser Lauf nichts gestartet hat oder scheiterte.
    await scheduleParallelCheck(projectId);
  }
};

async function checkOnce(projectId: string, workspacePath: string | null, scrumMasterId: string): Promise<void> {
  if (!workspacePath) return; // Erster Arbeitstag ist noch nicht durchgelaufen.

  const sprint = await prisma.sprint.findFirst({ where: { projectId, status: "ACTIVE" } });
  if (!sprint) return;

  if ((await projectBlocker(projectId)) || (await sprintBlocker(sprint.id))) return;

  const openTickets = await prisma.ticket.findMany({
    where: { sprintId: sprint.id, status: { not: "DONE" } },
  });
  const runningIds = await activeTicketJobIds(openTickets.map((ticket) => ticket.id));
  if (runningIds.size === 0 || runningIds.size >= MAX_PARALLEL_TICKETS) return;

  const primary = openTickets.find((ticket) => runningIds.has(ticket.id));
  if (!primary) return;

  const candidates = (await pullableTickets(sprint.id)).filter(
    (ticket) => !runningIds.has(ticket.id) && ticket.assigneeId && ticket.assigneeId !== primary.assigneeId,
  );
  const candidate = candidates[0];
  if (!candidate) return;

  const scrumMaster = await prisma.agent.findUniqueOrThrow({ where: { id: scrumMasterId } });
  const judged = await runAgent({
    agent: scrumMaster,
    projectId,
    kind: "parallel_check",
    headline: `Prüft, ob „${candidate.title}" parallel zu „${primary.title}" laufen kann`,
    maxTokens: 400,
    system: `${TEAM_GRUNDREGELN}

Du bist ${scrumMaster.name}, Scrum Master. Du prüfst NUR, ob zwei Tickets gefahrlos gleichzeitig von zwei verschiedenen Kollegen bearbeitet werden können, ohne sich bei Dateien oder fachlichen Bereichen in die Quere zu kommen – du änderst nichts und entscheidest nichts anderes. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `## Ticket A (läuft bereits)
${primary.title}
${(primary.description ?? "").slice(0, 1500)}

## Ticket B (Kandidat für parallele Arbeit)
${candidate.title}
${(candidate.description ?? "").slice(0, 1500)}

Können beide Tickets unabhängig voneinander umgesetzt werden – also aller Voraussicht nach unterschiedliche Dateien/Bereiche betreffen, ohne dass eines vom Ergebnis des anderen abhängt? Sei konservativ: Bei Zweifel, bei überlappenden Bereichen, oder wenn B fachlich auf A aufbauen könnte, antworte mit "unabhaengig": false.

Antworte nur so:
{"unabhaengig": true|false, "begruendung": "ein bis zwei Sätze"}`,
  });

  const parsed = extractJsonObject(judged.text);
  const independent = parsed.unabhaengig === true;
  const reasoning = String(parsed.begruendung ?? "").trim().slice(0, 400);
  if (!independent) return;

  const candidateAgent = await prisma.agent.findUnique({ where: { id: candidate.assigneeId! } });
  if (!candidateAgent) return;

  const worktreeDir = await createTicketWorktree(workspacePath, projectId, candidate.id);
  await prisma.ticket.update({ where: { id: candidate.id }, data: { worktreePath: worktreeDir } });

  await logActivity({
    projectId,
    ticketId: candidate.id,
    agentId: scrumMaster.id,
    actor: scrumMaster.name,
    action: "parallel_work_started",
    detail: `${scrumMaster.name} startet parallele Arbeit an „${candidate.title}" neben „${primary.title}" – ${reasoning || "unabhängige Bereiche"}`,
  });

  await enqueueAgentJob("ticketWork", {
    agentId: candidateAgent.id,
    projectId,
    ticketId: candidate.id,
    reason: `Parallel zu „${primary.title}" gestartet (Scrum Master: ${reasoning || "unabhängige Bereiche"})`,
  });
}

export default parallelCheck;
