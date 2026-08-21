// Was steht als Nächstes an? – die eine Antwort für alle Wege zurück in die
// Arbeit: „Fortsetzen", „Nächsten Schritt anstoßen" und der Beschluss einer
// Klärung.
//
// Bewusst aus dem Projektstand abgeleitet und nicht mitgeführt: Nach einer
// Pause, einem Absturz oder einem Beschluss weiß niemand mehr zuverlässig, wo
// die Kette abgerissen ist – das Board weiß es.
//
// Kein "use server": Die Datei enthält Hilfslogik, keine Server-Action.
import { prisma } from "@/lib/prisma";
import { agentForRole } from "@/lib/team";
import { enqueueAgentJob } from "../../worker/queue";
import { nextOpenTicket, nextOpenTickets } from "../../worker/orchestration";

export async function scheduleNextStep(projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const sprint = await prisma.sprint.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
    include: { tickets: true },
  });

  // Noch kein Arbeitsplatz/Sprint: erster Arbeitstag.
  if (!project.workspacePath || !sprint) {
    const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
    if (!productOwner) return "Es ist kein Team zugeordnet.";
    await enqueueAgentJob("teamKickoff", {
      agentId: productOwner.id,
      projectId,
      reason: "Arbeit aufgenommen",
    });
    return `${productOwner.name} richtet das Repository ein und liest den Auftrag.`;
  }

  if (sprint.status === "DONE") {
    const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
    if (!productOwner) return "Es ist kein Product Owner zugeordnet.";
    await enqueueAgentJob("sprintPlanning", {
      agentId: productOwner.id,
      projectId,
      reason: "nächster Sprint angestoßen",
    });
    return `${productOwner.name} plant Sprint ${sprint.number + 1}.`;
  }

  // Tickets mit offener Klärung, unerledigter Abhängigkeit oder unfertiger
  // Backend-Vorarbeit (siehe worker/clarification.ts#blockedTicketIds)
  // bleiben liegen – sonst schickt „weitermachen" das Team genau in die
  // Frage zurück, die noch niemand beantwortet hat, oder vor ein Ticket,
  // dessen Voraussetzung laut Product Owner noch fehlt. SEQUENTIAL holt wie
  // bisher genau ein Ticket, PARALLEL weckt alle gerade abholbaren auf einmal
  // (siehe worker/orchestration.ts#continueSprint für dieselbe Fallunterscheidung
  // im automatischen Ablauf).
  const openTickets =
    project.workMode === "PARALLEL"
      ? await nextOpenTickets(sprint.id)
      : await nextOpenTicket(sprint.id).then((ticket) => (ticket ? [ticket] : []));

  if (openTickets.length > 0) {
    const messages: string[] = [];
    for (const ticket of openTickets) {
      const assignee = ticket.assigneeId
        ? await prisma.agent.findUnique({ where: { id: ticket.assigneeId } })
        : await agentForRole(projectId, "BACKEND");
      if (!assignee) continue;
      await enqueueAgentJob("ticketWork", {
        agentId: assignee.id,
        projectId,
        ticketId: ticket.id,
        reason: "von Hand angestoßen",
      });
      messages.push(`${assignee.name} übernimmt „${ticket.title}".`);
    }
    if (messages.length > 0) return messages.join(" ");
    return "Für das nächste Ticket ist niemand zuständig.";
  }

  // Kein abholbares Ticket heisst noch nicht "fertig" – massgeblich ist
  // einzig der Ticket-Status. Ein Ticket auf IN_REVIEW ohne gerade offene
  // Klärung (z.B. in der Lücke zwischen "Klärung entschieden" und "Job vom
  // Worker abgeholt", oder während einer menschlichen Freigabe/ReviewApproval)
  // zählte hier vorher als erledigt und der Sprint wurde faelschlich
  // abgeschlossen – siehe dieselbe Korrektur in worker/orchestration.ts
  // (continueSprint), die dieselbe Prüfung für den automatischen Ablauf macht.
  const stillNotDone = sprint.tickets.some((ticket) => ticket.status !== "DONE");
  if (stillNotDone) {
    return "Die übrigen Tickets des Sprints laufen noch oder warten auf einen Beschluss – der Sprint bleibt so lange offen.";
  }

  const scrumMaster = await agentForRole(projectId, "SCRUM_MASTER");
  if (!scrumMaster) return "Es ist kein Scrum Master zugeordnet.";
  await enqueueAgentJob("sprintReview", {
    agentId: scrumMaster.id,
    projectId,
    sprintId: sprint.id,
    reason: "von Hand angestoßen",
  });
  return `${scrumMaster.name} schließt Sprint ${sprint.number} ab.`;
}
