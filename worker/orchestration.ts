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
import { blockedTicketIds, openClarification, projectBlocker, sprintBlocker } from "./clarification";

/// Vorgabe fuer das Sprint-Budget eines Projekts (`Project.sprintBudget`).
/// Ohne Obergrenze wuerde das Team unbegrenzt weiterbauen und Modellkosten
/// erzeugen; mit ihr beruft es eine Klaerung ein und laesst den Auftraggeber
/// entscheiden, so wie ein Team am Ende eines Quartals.
export const MAX_SPRINTS = 12;

/// Nur ein aktives Projekt arbeitet. Steht es auf Pausiert/Archiviert, bricht
/// der Task ohne Fehler ab – das ist der Not-Aus des Menschen. Dasselbe gilt
/// fuer eine offene Klaerung, die das ganze Projekt betrifft: Solange die
/// Grundsatzfrage nicht entschieden ist, arbeitet niemand weiter.
export async function loadWorkingProject(projectId: string): Promise<Project | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  if (project.status !== "ACTIVE") return null;
  if (await projectBlocker(projectId)) return null;
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
    // Frueher endete die Kette hier stillschweigend im Protokoll. Jetzt ist es
    // eine Frage an den Menschen: Es fehlt schlicht jemand fuer die Rolle.
    await openClarification({
      projectId,
      scope: "PROJECT",
      trigger: "no_agent",
      question: `Für die Rolle ${role} ist niemand im Projekt – wer soll das übernehmen?`,
      context:
        `Der nächste Schritt (${taskIdentifier}) braucht die Rolle ${role}. ` +
        `Unter „Team & Connectoren" lässt sich jemand zuordnen; danach kann das Team weiterarbeiten.`,
      options: [
        {
          key: "resume",
          label: "Ist zugeordnet – weitermachen",
          detail: "Scrumy nimmt den nächsten fälligen Schritt wieder auf.",
          effect: "resume",
        },
        { key: "stop", label: "Team anhalten", effect: "stop" },
      ],
      // Ohne Team kann auch der Scrum Master keine Agenda schreiben.
      prepare: false,
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
/// Board. Tickets mit offener Klaerung bleiben liegen: Sie warten auf einen
/// Beschluss, das Team zieht solange das naechste.
export async function nextOpenTicket(sprintId: string) {
  const blocked = await blockedTicketIds(sprintId);
  return prisma.ticket.findFirst({
    where: {
      sprintId,
      status: { in: ["BACKLOG", "IN_PROGRESS"] },
      ...(blocked.length > 0 ? { id: { notIn: blocked } } : {}),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

/// Nach jedem Ticket: entweder das naechste ziehen oder den Sprint zum Review
/// geben.
export async function continueSprint(projectId: string, sprintId: string): Promise<void> {
  // Eine Klaerung zum Sprint selbst (z.B. „passt das Sprintziel ueberhaupt
  // noch?") haelt den ganzen Sprint an, nicht nur ein Ticket.
  if (await sprintBlocker(sprintId)) {
    await logActivity({
      projectId,
      actor: "Scrumy",
      action: "team_waiting",
      detail: "Der Sprint wartet auf einen Beschluss – kein weiteres Ticket wird gezogen.",
    });
    return;
  }

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

  // Kein Ticket mehr abholbar (BACKLOG/IN_PROGRESS, unblockiert) heisst noch
  // nicht "fertig". Massgeblich ist einzig der Ticket-Status: Ein Ticket kann
  // auf IN_REVIEW stehen, ohne dass gerade eine offene Klaerung dranhaengt –
  // z.B. in der kurzen Luecke zwischen "Klaerung entschieden" und "Nacharbeits-
  // Job vom Worker abgeholt", oder waehrend es auf eine menschliche Freigabe
  // (ReviewApproval) wartet. Frueher wurde hier nur auf offene Klaerungen
  // geprueft – das erklaerte den Sprint faelschlich fuer fertig, sobald genau
  // diese Luecke zufaellig mit dem Check zusammenfiel (Sprint schloss mit
  // "3/4 Tickets", das vierte lief in Wahrheit noch). Jetzt zaehlt: erst wenn
  // WIRKLICH jedes Ticket DONE ist, geht es zum Review.
  const notDone = await prisma.ticket.findMany({
    where: { sprintId, status: { not: "DONE" } },
    select: { id: true },
  });
  if (notDone.length > 0) {
    const blocked = new Set(await blockedTicketIds(sprintId));
    const blockedCount = notDone.filter((entry) => blocked.has(entry.id)).length;
    const runningCount = notDone.length - blockedCount;
    const detail =
      blockedCount > 0 && runningCount > 0
        ? `${blockedCount} Ticket(s) warten auf einen Beschluss, ${runningCount} weitere(s) laufen noch – der Sprint bleibt so lange offen.`
        : blockedCount > 0
          ? `${blockedCount} Ticket(s) warten auf einen Beschluss – der Sprint bleibt so lange offen.`
          : `${runningCount} Ticket(s) laufen noch – der Sprint bleibt so lange offen.`;
    await logActivity({ projectId, actor: "Scrumy", action: "team_waiting", detail });
    return;
  }

  await handOverTo("SCRUM_MASTER", "sprintReview", projectId, {
    sprintId,
    reason: "alle Tickets des Sprints sind durch",
  });
}
