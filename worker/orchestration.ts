// Der Taktgeber des Teams: Welcher Schritt folgt auf welchen, und wann hört
// das Team von selbst auf zu arbeiten.
//
// Die Kette ist bewusst schlicht: Kickoff → Sprint-Planung → Ticket → Ticket →
// … → Sprint-Review → (Autopilot) nächste Sprint-Planung. Jeder Task reiht am
// Ende den nächsten ein, statt dass ein zentraler Scheduler alles steuert –
// dadurch gibt es nie zwei gleichzeitig laufende Arbeitsstränge in einem
// Projekt, und ein abgestürzter Schritt reißt die Kette sauber ab, statt im
// Hintergrund weiterzurattern.
import { prisma } from "@/lib/prisma";
import { agentForRole } from "@/lib/team";
import type { AgentRole, Project } from "@/generated/prisma/client";
import { enqueueAgentJob } from "./queue";
import { logActivity } from "./agentRun";

/// Obergrenze fuer den Autopiloten. Ohne sie wuerde das Team unbegrenzt
/// weiterbauen (und Modellkosten erzeugen); mit ihr haelt es an und wartet auf
/// den Menschen, so wie ein Team am Ende eines Quartals.
export const MAX_SPRINTS = 12;

/// Nur ein aktives Projekt arbeitet. Steht es auf Pausiert/Archiviert, bricht
/// der Task ohne Fehler ab – das ist der Not-Aus des Menschen.
export async function loadWorkingProject(projectId: string): Promise<Project | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  if (project.status !== "ACTIVE") return null;
  return project;
}

/// Reiht den naechsten Schritt fuer die passende Rolle ein.
export async function handOverTo<TIdentifier extends keyof GraphileWorker.Tasks>(
  role: AgentRole,
  taskIdentifier: TIdentifier,
  projectId: string,
  payload: Omit<GraphileWorker.Tasks[TIdentifier], "agentId" | "projectId">,
): Promise<boolean> {
  const agent = await agentForRole(projectId, role);
  if (!agent) {
    await logActivity({
      projectId,
      actor: "Scrumy",
      action: "team_blocked",
      detail: `Kein Agent für die Rolle ${role} im Projekt – Arbeit angehalten.`,
    });
    return false;
  }

  await enqueueAgentJob(taskIdentifier, {
    ...payload,
    agentId: agent.id,
    projectId,
  } as GraphileWorker.Tasks[TIdentifier]);
  return true;
}

/// Naechstes offenes Ticket des aktiven Sprints – die Reihenfolge ist die
/// Backlog-Reihenfolge (Prioritaet, dann Erstellung), wie beim Ziehen vom
/// Board.
export async function nextOpenTicket(sprintId: string) {
  return prisma.ticket.findFirst({
    where: { sprintId, status: { in: ["BACKLOG", "IN_PROGRESS"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

/// Nach jedem Ticket: entweder das naechste ziehen oder den Sprint zum Review
/// geben.
export async function continueSprint(projectId: string, sprintId: string): Promise<void> {
  const ticket = await nextOpenTicket(sprintId);

  if (ticket) {
    const reason = `nächstes Ticket im Sprint: ${ticket.title}`;

    // Ohne Zustaendigen zieht der Generalist (Backend) – ein Ticket bleibt
    // nicht liegen, nur weil die Planung niemanden zugeordnet hat.
    if (ticket.assigneeId) {
      await enqueueAgentJob("ticketWork", {
        agentId: ticket.assigneeId,
        projectId,
        ticketId: ticket.id,
        reason,
      });
    } else {
      await handOverTo("BACKEND", "ticketWork", projectId, { ticketId: ticket.id, reason });
    }
    return;
  }

  await handOverTo("SCRUM_MASTER", "sprintReview", projectId, {
    sprintId,
    reason: "alle Tickets des Sprints sind durch",
  });
}
