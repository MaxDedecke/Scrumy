// Was eine Freigabe-Entscheidung auslöst – losgelöst davon, wer sie trifft.
//
// Bis hierher konnte nur der Mensch ein abgegebenes Ticket freigeben oder zur
// Nachbesserung zurückschicken (`decideReview`, eine Server-Action). Seit der
// Product Owner angefragte Freigaben selbst prüft (siehe
// worker/tasks/reviewTriage.ts), braucht dieselbe Wirkung – Beschluss
// festhalten, Ticket auf DONE/IN_PROGRESS setzen, bei Nachbesserung den
// Kollegen mit Rückmeldung erneut einreihen – auch einen Weg aus dem Worker
// heraus. Diese Datei ist dieser eine Weg für beide Seiten.
import { prisma } from "@/lib/prisma";
import { agentForRole } from "@/lib/team";
import { enqueueAgentJob } from "../../worker/queue";
import { continueSprint } from "../../worker/orchestration";
import { integrateAndFinalizeTicket } from "../../worker/ticketWorktree";
import type { ReviewDecision } from "@/generated/prisma/client";

export interface ResolveReviewInput {
  reviewId: string;
  decision: ReviewDecision;
  comment: string | null;
  /// "Mensch" oder z.B. "Pia Ostermann (Product Owner)".
  decidedBy: string;
}

/// Haelt eine Freigabe-Entscheidung fest und setzt ihre Wirkung in Gang.
/// Genutzt sowohl vom Menschen im Büro (`decideReview`) als auch vom Product
/// Owner, wenn er eine angefragte Freigabe selbst entscheidet.
export async function resolveReview(input: ResolveReviewInput): Promise<string> {
  const { reviewId, decision, comment, decidedBy } = input;

  const review = await prisma.reviewApproval.findUniqueOrThrow({
    where: { id: reviewId },
    include: { ticket: true },
  });
  const ticket = review.ticket;
  const projectId = ticket.projectId;

  await prisma.$transaction([
    prisma.reviewApproval.update({
      where: { id: reviewId },
      data: {
        decision,
        comment: comment ?? review.comment,
        decidedAt: new Date(),
        reviewerName: decidedBy,
      },
    }),
    // Bei REJECTED direkt hier auf IN_PROGRESS – bei APPROVED NICHT hier
    // schon auf DONE: Lief das Ticket in einem eigenen Git-Worktree (siehe
    // worker/ticketWorktree.ts), muss dessen Branch erst in den Hauptbranch
    // übernommen werden. Das ist ein Git-Vorgang, der nicht in dieselbe
    // Datenbank-Transaktion passt – siehe `integrateAndFinalizeTicket` unten.
    ...(decision === "REJECTED" ? [prisma.ticket.update({ where: { id: ticket.id }, data: { status: "IN_PROGRESS" } })] : []),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: ticket.id,
        actor: decidedBy,
        action: decision === "APPROVED" ? "human_approved" : "human_rejected",
        detail:
          `„${ticket.title}" ${decision === "APPROVED" ? "freigegeben" : "zur Nachbesserung zurückgegeben"}` +
          (comment ? `: ${comment}` : ""),
      },
    }),
  ]);

  if (decision === "APPROVED") {
    const finalized = await integrateAndFinalizeTicket({ ticketId: ticket.id, projectId });
    if (!finalized.ok) {
      // Freigabe steht, aber das Zusammenführen mit dem Hauptbranch ist
      // gescheitert (nicht auflösbarer Merge-Konflikt) – das Ticket bleibt
      // bewusst NICHT auf DONE stehen. Derselbe Umsetzer bekommt einen
      // weiteren Anlauf; dessen billige Vorprüfung (siehe ticketWork.ts,
      // checkAlreadySatisfied) erkennt den bereits fertigen Code normalerweise
      // sofort wieder und versucht nur die Übernahme erneut.
      await prisma.activityLogEntry.create({
        data: {
          projectId,
          ticketId: ticket.id,
          actor: "Scrumy",
          action: "step_failed",
          detail: `„${ticket.title}" ist freigegeben, aber das Zusammenführen mit dem Hauptbranch ist gescheitert: ${finalized.error.slice(0, 300)}`,
        },
      });
      const assignee = ticket.assigneeId
        ? await prisma.agent.findUnique({ where: { id: ticket.assigneeId } })
        : await agentForRole(projectId, "BACKEND");
      if (assignee) {
        await enqueueAgentJob("ticketWork", {
          agentId: assignee.id,
          projectId,
          ticketId: ticket.id,
          reason: `Zusammenführen mit dem Hauptbranch fehlgeschlagen: ${finalized.error.slice(0, 200)}`,
        });
      }
      return `„${ticket.title}" ist freigegeben, aber das Zusammenführen mit dem Hauptbranch ist fehlgeschlagen – das Team versucht es erneut.`;
    }
  }

  // Zurueckgewiesen heisst: derselbe Kollege macht weiter, mit der
  // Begruendung als neuer Vorgabe.
  if (decision === "REJECTED") {
    const assignee = ticket.assigneeId
      ? await prisma.agent.findUnique({ where: { id: ticket.assigneeId } })
      : await agentForRole(projectId, "BACKEND");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    if (assignee && project.status === "ACTIVE") {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          plan: `${ticket.plan ?? ""}\n\n## Rückmeldung (${decidedBy})\n${comment ?? "(ohne Begründung)"}`,
        },
      });
      await enqueueAgentJob("ticketWork", {
        agentId: assignee.id,
        projectId,
        ticketId: ticket.id,
        reason: `Nacharbeit nach Nachbesserung durch ${decidedBy}: ${(comment ?? "").slice(0, 200)}`,
      });
      return `„${ticket.title}" zur Nachbesserung zurückgegeben – das Team arbeitet nach.`;
    }
    return `„${ticket.title}" zur Nachbesserung zurückgegeben.`;
  }

  // APPROVED heisst: dieses Ticket ist fertig, aber das Team macht davon noch
  // nicht von selbst weiter – anders als beim eigenen Review-Abschluss in
  // ticketWork.ts (dort folgt auf "status: DONE" immer ein continueSprint)
  // fehlte dieser Schritt hier bislang komplett. Ohne ihn blieb das Team nach
  // einer menschlichen/PO-Freigabe stehen, bis irgendein anderer Vorgang
  // zufällig continueSprint auslöste – z.B. beim letzten Ticket eines Sprints
  // gar nicht mehr, der Sprint wurde nie abgeschlossen.
  if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
  return `„${ticket.title}" freigegeben.`;
}
