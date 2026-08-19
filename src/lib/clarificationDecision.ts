// Was ein Beschluss zu einer Klärung auslöst – losgelöst davon, wer ihn fasst.
//
// Bis hierher konnte nur der Mensch entscheiden (`decideClarification`, eine
// Server-Action). Seit der Product Owner Klärungen selbst prüft (siehe
// worker/tasks/clarificationTriage.ts), braucht dieselbe Wirkung – festhalten,
// ans Ticket hängen, eingefrorenen Schritt wieder aufnehmen – auch einen Weg
// aus dem Worker heraus, ohne Formular und Server-Action-Grenze. Diese Datei
// ist dieser eine Weg für beide Seiten.
import { prisma } from "@/lib/prisma";
import { scheduleNextStep } from "@/lib/nextStep";
import { TICKET_ATTEMPT_GRANT, type ClarificationEffect } from "@/lib/clarificationOptions";
import { enqueueAgentJob } from "../../worker/queue";

/// Um wie viele Sprints das Budget waechst, wenn weitergearbeitet werden darf
/// (siehe worker/tasks/sprintPlanning.ts).
const SPRINT_BUDGET_STEP = 6;

export interface ResolveClarificationInput {
  clarificationId: string;
  /// Fertig zusammengesetzter Beschlusstext (Option + ggf. Begründung/Kommentar).
  decision: string;
  effect: ClarificationEffect;
  /// "Mensch" oder z.B. "Pia Ostermann (Product Owner)".
  decidedBy: string;
  /// Hat ein Mensch entschieden? Entscheidet darueber, ob ein
  /// "nochmal versuchen" dem Ticket wirklich neue Anlaeufe bewilligt. Ein
  /// Agent, der sich selbst weitere Versuche genehmigt, hebelt die Obergrenze
  /// aus, die ihn gerade gestoppt hat – genau das war die Dauerschleife.
  byHuman: boolean;
}

/// Haelt einen Beschluss fest und setzt seine Wirkung in Gang. Genutzt sowohl
/// vom Menschen im Büro (`decideClarification`) als auch vom Product Owner,
/// wenn er eine Klärung selbst entscheidet.
export async function resolveClarification(input: ResolveClarificationInput): Promise<string> {
  const { clarificationId, decision, effect, decidedBy, byHuman } = input;

  const clarification = await prisma.clarification.findUniqueOrThrow({
    where: { id: clarificationId },
    include: { ticket: true },
  });

  await prisma.$transaction([
    prisma.clarification.update({
      where: { id: clarificationId },
      data: { status: "DECIDED", decision, decidedBy, decidedAt: new Date() },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId: clarification.projectId,
        ticketId: clarification.ticketId,
        actor: decidedBy,
        action: "clarification_decided",
        detail: `Beschluss zu „${clarification.question.slice(0, 160)}": ${decision.slice(0, 300)}`,
      },
    }),
  ]);

  // Der Beschluss gehoert auch dorthin, wo der naechste Agent ihn garantiert
  // liest: in den Plan des Tickets, an dem er weiterarbeitet.
  if (clarification.ticket) {
    await prisma.ticket.update({
      where: { id: clarification.ticket.id },
      data: {
        plan:
          `${clarification.ticket.plan ?? ""}\n\n## Beschluss (${decidedBy})\n` +
          `Frage: ${clarification.question}\nBeschluss: ${decision}`,
      },
    });
  }

  // Weitergeleitete Frage: Der Vorgang im Postfach ist damit erledigt.
  if (clarification.forwardedRequestId) {
    await prisma.supportRequest.update({
      where: { id: clarification.forwardedRequestId },
      data: { status: "CLOSED" },
    });
  }

  return applyEffect(effect, clarification.id, clarification.projectId, byHuman);
}

/// Was ein Beschluss in der Arbeit bewirkt. Ohne diesen Schritt waere eine
/// Klaerung nur eine Notiz – das Team stuende weiter still.
async function applyEffect(
  effect: ClarificationEffect,
  clarificationId: string,
  projectId: string,
  byHuman: boolean,
): Promise<string> {
  const clarification = await prisma.clarification.findUniqueOrThrow({ where: { id: clarificationId } });

  if (effect === "stop") {
    await prisma.$transaction([
      prisma.project.update({ where: { id: projectId }, data: { autopilot: false } }),
      prisma.activityLogEntry.create({
        data: {
          projectId,
          actor: clarification.decidedBy ?? "Mensch",
          action: "team_waiting",
          detail: "Das Team arbeitet auf diesen Beschluss hin nicht weiter.",
        },
      }),
    ]);
    return `Das Team bleibt stehen – über „Nächsten Schritt anstoßen" geht es weiter.`;
  }

  if (effect === "skip" && clarification.ticketId) {
    // Zurueck in den Backlog statt im Sprint zu verhungern: Das Ticket bleibt
    // erhalten, aber der laufende Sprint kommt ohne es zum Abschluss.
    const ticket = await prisma.ticket.update({
      where: { id: clarification.ticketId },
      data: { status: "BACKLOG", sprintId: null },
    });
    await prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: ticket.id,
        actor: clarification.decidedBy ?? "Mensch",
        action: "ticket_deferred",
        detail: `„${ticket.title}" zurück in den Backlog gestellt.`,
      },
    });
    const next = await scheduleNextStep(projectId);
    return `„${ticket.title}" liegt wieder im Backlog. ${next}`;
  }

  if (effect === "close" && clarification.ticketId) {
    // Anders als "resume" wird hier bewusst NICHTS erneut eingereiht: Der
    // Beschluss lautet "fertig", nicht "nochmal versuchen". Ohne diese
    // Abzweigung landete ein "schließen"-Beschluss auf dem eingefrorenen
    // Arbeitsschritt und der scheiterte bei strukturell blockierten Tickets
    // (z.B. eine gesperrte Datei) identisch wieder – Klärung um Klärung, ohne
    // dass der Ticket-Status sich je bewegte.
    const ticket = await prisma.ticket.update({
      where: { id: clarification.ticketId },
      data: { status: "DONE" },
    });
    await prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: ticket.id,
        actor: clarification.decidedBy ?? "Mensch",
        action: "ticket_closed_by_decision",
        detail: `„${ticket.title}" auf Beschluss hin geschlossen, ohne weiteren Anlauf.`,
      },
    });
    const next = await scheduleNextStep(projectId);
    return `„${ticket.title}" ist geschlossen. ${next}`;
  }

  if (effect === "budget") {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: { sprintBudget: { increment: SPRINT_BUDGET_STEP }, autopilot: true },
    });
    const next = await resume(clarification.resumeTask, clarification.resumePayload, projectId);
    return `Budget steht jetzt bei ${project.sprintBudget} Sprints. ${next}`;
  }

  // "Nochmal versuchen" ist nur dann wirklich ein neuer Anlauf, wenn das
  // Ticket dafuer auch Budget hat (siehe `Ticket.attemptBudget`). Aufstocken
  // darf allein der Mensch: Er hat den Beschluss gefasst und traegt die
  // Kosten des naechsten Versuchs.
  if (effect === "resume" && byHuman && clarification.ticketId) {
    const ticket = await prisma.ticket.update({
      where: { id: clarification.ticketId },
      data: { attemptBudget: { increment: TICKET_ATTEMPT_GRANT } },
    });
    const next = await resume(clarification.resumeTask, clarification.resumePayload, projectId);
    return `„${ticket.title}" hat ${TICKET_ATTEMPT_GRANT} weitere Anläufe (insgesamt ${ticket.attemptBudget}). ${next}`;
  }

  return resume(clarification.resumeTask, clarification.resumePayload, projectId);
}

/// Nimmt den eingefrorenen Schritt wieder auf. Ist keiner hinterlegt (z.B. bei
/// einem durch Neustart verlorenen Job), bestimmt Scrumy aus dem Board, was
/// ansteht – das Team soll nie am fehlenden Payload scheitern.
async function resume(task: string | null, payload: unknown, projectId: string): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.status !== "ACTIVE") {
    return `Das Projekt ist nicht aktiv – über „Arbeit fortsetzen" nimmt das Team sie wieder auf.`;
  }

  if (task && payload && typeof payload === "object") {
    const agentId = (payload as { agentId?: string }).agentId;
    if (agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (agent) {
        // Der eingefrorene Payload stammt aus derselben Queue, in die er
        // zurueckgeht – die Typen sind dieselben, nur ueber die Datenbank
        // gereist und dadurch fuer TypeScript wieder unbekannt.
        await enqueueAgentJob(
          task as keyof GraphileWorker.Tasks,
          payload as GraphileWorker.Tasks[keyof GraphileWorker.Tasks],
        );
        // Blockiert-Anzeige aufheben: Der Kollege hat wieder etwas zu tun.
        await prisma.agent.updateMany({
          where: { id: agent.id, status: "BLOCKED" },
          data: { status: "IDLE" },
        });
        return `${agent.name} nimmt die Arbeit wieder auf.`;
      }
    }
  }

  return scheduleNextStep(projectId);
}
