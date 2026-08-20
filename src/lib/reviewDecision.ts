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
    prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: decision === "APPROVED" ? "DONE" : "IN_PROGRESS" },
    }),
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
