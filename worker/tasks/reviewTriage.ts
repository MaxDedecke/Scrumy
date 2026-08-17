// Bevor eine angefragte Freigabe im Büro landet, prüft sie der Product Owner.
//
// Nicht jede Freigabe braucht den Auftraggeber: Lässt sich eine falsche
// Entscheidung mit überschaubarem Aufwand wieder geradebiegen – ein Ticket
// freigeben, das sich notfalls in einem späteren Ticket nachbessern lässt,
// oder es mit Rückmeldung zur Nacharbeit zurückschicken –, entscheidet der
// Product Owner selbst, und das Ticket kommt sofort weiter. Ist die Sache
// heikel, bleibt sie unangetastet im Büro liegen, nur um seine Einschätzung
// ergänzt.
//
// Läuft nie für als kritisch markierte Tickets: `isCritical` erzwingt
// menschliches Review vor Deploy, und diese Einstufung hat der Product Owner
// selbst schon bei der Sprint-Planung getroffen (siehe worker/tasks/
// sprintPlanning.ts) – eine erneute Prüfung durch dieselbe Rolle würde den
// eigenen Beschluss nur unterlaufen. `requestHumanReview` in ticketWork.ts
// reiht diesen Task deshalb gar nicht erst ein.
//
// Wie clarificationTriage: kein eigener Klärungs-Umschlag im Fehlerfall.
// Scheitert die Prüfung, bleibt die Freigabe einfach ungeprüft im Büro
// stehen.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { AGENT_ROLE_LABEL, PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { resolveReview } from "@/lib/reviewDecision";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import type { ReviewTriagePayload } from "../taskTypes";

const reviewTriage: Task<"reviewTriage"> = async (payload: ReviewTriagePayload, helpers) => {
  const { agentId, projectId, reviewId } = payload;

  const review = await prisma.reviewApproval.findUnique({ where: { id: reviewId }, include: { ticket: true } });
  if (!review || review.decision !== "PENDING") return;
  const ticket = review.ticket;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const role = `${agent.name} (${AGENT_ROLE_LABEL[agent.role]})`;

  try {
    const context = await buildProjectContext(projectId, { includeRepo: false });
    const { text } = await runAgent({
      agent,
      projectId,
      ticketId: ticket.id,
      sprintId: ticket.sprintId ?? undefined,
      kind: "review_triage",
      headline: `Prüft eine Freigabe: „${ticket.title.slice(0, 80)}"`,
      maxTokens: 1200,
      system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, ${AGENT_ROLE_LABEL[agent.role]}. Das Team bittet den Auftraggeber um eine Freigabe. Bevor sie vorgelegt wird, prüfst du: Darfst du sie im Sinne des Auftrags selbst entscheiden, oder gehört sie ihm vorgelegt? Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${context}

# Das Ticket
„${ticket.title}" (${TICKET_TYPE_LABEL[ticket.type]}, Priorität ${PRIORITY_LABEL[ticket.priority]})
${ticket.description ? `\nBeschreibung: ${ticket.description}\n` : ""}
## Warum eine Freigabe ansteht
${review.comment ?? "(kein Grund vermerkt)"}

## Stand der Umsetzung
${ticket.result ?? "(kein Abschlussbericht)"}

Entscheide selbst, wenn eine falsche Entscheidung sich mit überschaubarem Aufwand wieder geradebiegen lässt – freigeben, was sich notfalls in einem späteren Ticket nachbessern lässt, oder mit klarer Rückmeldung zur Nacharbeit zurückschicken. Leg die Freigabe dem Auftraggeber vor (kritisch = true), wenn eine falsche Entscheidung schwer umkehrbar ist – Datenverlust, Sicherheit oder Datenschutz, spürbare Mehrkosten, Auswirkungen auf Produktivsysteme oder Kundendaten, oder eine Änderung am Auftrag selbst. Im Zweifel: vorlegen.

Antworte nur mit diesem JSON-Objekt:
{
  "kritisch": true oder false,
  "begruendung": "ein bis zwei Sätze, wie du zu der Einschätzung kommst",
  "entscheidung": "freigeben oder nachbessern – nur wenn kritisch=false",
  "rueckmeldung": "bei nachbessern: was der Kollege konkret ändern soll"
}`,
    });

    const parsed = extractJsonObject(text);
    const critical = Boolean(parsed.kritisch);
    const reasoning = typeof parsed.begruendung === "string" ? parsed.begruendung.trim().slice(0, 600) : "";
    const verdict = typeof parsed.entscheidung === "string" ? parsed.entscheidung.trim().toLowerCase() : "";
    const feedback = typeof parsed.rueckmeldung === "string" ? parsed.rueckmeldung.trim().slice(0, 600) : "";

    if (!critical && (verdict === "freigeben" || verdict === "nachbessern")) {
      const decision = verdict === "freigeben" ? "APPROVED" : "REJECTED";
      const comment =
        decision === "APPROVED" ? reasoning || null : [feedback, reasoning].filter(Boolean).join(" – ") || null;
      // `resolveReview` haelt den Beschluss bereits im Protokoll fest – ein
      // zweiter Eintrag waere nur Wiederholung.
      await resolveReview({ reviewId, decision, comment, decidedBy: role });
      return;
    }

    // Heikel, oder das Modell hat keine eindeutige Entscheidung getroffen: Die
    // Freigabe bleibt offen, nur um die Einschätzung ergänzt. `updateMany`
    // statt `update`: Hat der Mensch in der Zwischenzeit schon entschieden,
    // darf die Einschätzung den Beschluss nicht mehr anfassen.
    const note = reasoning || "Das lege ich dir vor – zu heikel für eine Eigenentscheidung.";
    await prisma.reviewApproval.updateMany({
      where: { id: reviewId, decision: "PENDING" },
      data: { comment: [`**${role}:** ${note}`, review.comment].filter(Boolean).join("\n\n") },
    });

    await logActivity({
      projectId,
      ticketId: ticket.id,
      agentId: agent.id,
      actor: agent.name,
      action: "review_escalated",
      detail: note,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Freigabe ${reviewId} konnte nicht geprüft werden: ${message}`);
  }
};

export default reviewTriage;
