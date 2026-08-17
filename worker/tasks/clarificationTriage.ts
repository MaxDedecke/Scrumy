// Bevor eine vorbereitete Klärung im Büro landet, prüft sie der Product Owner.
//
// Nicht jede Klärung braucht den Auftraggeber: Lässt sich eine falsche Wahl
// mit überschaubarem Aufwand wieder geradebiegen – nochmal umsetzen, Ansatz
// wechseln, Ticket zurückstellen –, entscheidet der Product Owner selbst, und
// das Team arbeitet sofort weiter. Ist die Sache heikel – schwer umkehrbar,
// teuer, oder betrifft den Auftrag selbst –, bleibt sie unangetastet im Büro
// liegen, nur um seine Einschätzung ergänzt, damit sichtbar ist, dass
// hingesehen wurde.
//
// Läuft nur für vorbereitete Klärungen: `clarificationPrep` stößt diesen
// Schritt an, sobald eine Agenda mit Wegen steht. Grundsatzfragen ohne Agenda
// (Sprint-Budget, leerer Backlog, fehlender Kollege, …) laufen bewusst ohne
// Vorbereitung und damit auch ohne Prüfung – sie gehören immer dem Menschen.
//
// Wie clarificationPrep: kein eigener Klärungs-Umschlag im Fehlerfall. Scheitert
// die Prüfung, bleibt die Klärung einfach ungeprüft im Büro stehen – lieber
// das als eine falsch automatisch getroffene Entscheidung.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { AGENT_ROLE_LABEL } from "@/lib/labels";
import { readOptions } from "@/lib/clarificationOptions";
import { resolveClarification } from "@/lib/clarificationDecision";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import type { ClarificationTriagePayload } from "../taskTypes";

const clarificationTriage: Task<"clarificationTriage"> = async (payload: ClarificationTriagePayload, helpers) => {
  const { agentId, projectId, clarificationId } = payload;

  const clarification = await prisma.clarification.findUnique({ where: { id: clarificationId } });
  if (!clarification || clarification.status !== "OPEN") return;

  const options = readOptions(clarification.options);
  // Ohne Wege gibt es nichts, worunter der Product Owner selbst waehlen
  // koennte – die Klaerung bleibt, wie sie ist.
  if (options.length === 0) return;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const role = `${agent.name} (${AGENT_ROLE_LABEL[agent.role]})`;

  try {
    const context = await buildProjectContext(projectId, { includeRepo: false });
    const { text } = await runAgent({
      agent,
      projectId,
      ticketId: clarification.ticketId ?? undefined,
      sprintId: clarification.sprintId ?? undefined,
      kind: "clarification_triage",
      headline: `Prüft eine Klärung: „${clarification.question.slice(0, 80)}"`,
      maxTokens: 1200,
      system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, ${AGENT_ROLE_LABEL[agent.role]}. Der Scrum Master hat eine Klärung mit gangbaren Wegen vorbereitet. Bevor sie dem Auftraggeber vorgelegt wird, prüfst du: Darfst du sie im Sinne des Auftrags selbst entscheiden, oder gehört sie ihm vorgelegt? Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${context}

# Die Klärung
Frage: ${clarification.question}
${clarification.agenda ? `\nEntscheidungsvorlage des Scrum Masters:\n${clarification.agenda}\n` : ""}
Wege:
${options.map((option, index) => `${index + 1}. ${option.label}${option.detail ? ` – ${option.detail}` : ""}`).join("\n")}

Entscheide selbst, wenn eine falsche Wahl sich mit überschaubarem Aufwand wieder geradebiegen lässt. Leg die Klärung dem Auftraggeber vor (kritisch = true), wenn sie schwer umkehrbar ist – Datenverlust, Sicherheit oder Datenschutz, spürbare Mehrkosten, Auswirkungen auf Produktivsysteme oder Kundendaten, oder eine Änderung am Auftrag selbst. Im Zweifel: vorlegen.

Antworte nur mit diesem JSON-Objekt:
{
  "kritisch": true oder false,
  "begruendung": "ein bis zwei Sätze, wie du zu der Einschätzung kommst",
  "gewaehlter_weg": "bei kritisch=false: der Titel des gewählten Wegs, wortgleich aus der Liste oben"
}`,
    });

    const parsed = extractJsonObject(text);
    const critical = Boolean(parsed.kritisch);
    const reasoning = typeof parsed.begruendung === "string" ? parsed.begruendung.trim().slice(0, 600) : "";
    const chosenLabel = typeof parsed.gewaehlter_weg === "string" ? parsed.gewaehlter_weg.trim() : "";
    const chosen = options.find(
      (option) => option.label.toLowerCase() === chosenLabel.toLowerCase() && chosenLabel.length > 0,
    );

    if (!critical && chosen) {
      // `resolveClarification` haelt den Beschluss bereits im Protokoll fest
      // (Frage + gewaehlter Weg) – ein zweiter Eintrag waere nur Wiederholung.
      const decision = `${chosen.label}${reasoning ? ` – ${reasoning}` : ""}`;
      await resolveClarification({ clarificationId, decision, effect: chosen.effect, decidedBy: role });
      return;
    }

    // Heikel, oder das Modell hat keinen der Wege eindeutig getroffen: Die
    // Klärung bleibt offen, nur um die Einschätzung ergänzt. `updateMany` statt
    // `update`: Hat der Mensch in der Zwischenzeit schon entschieden, darf die
    // Einschätzung den Beschluss nicht mehr anfassen.
    const note = reasoning || "Das lege ich dir vor – zu heikel für eine Eigenentscheidung.";
    await prisma.clarification.updateMany({
      where: { id: clarificationId, status: "OPEN" },
      data: {
        agenda: [`**${role}:** ${note}`, clarification.agenda].filter(Boolean).join("\n\n"),
      },
    });

    await logActivity({
      projectId,
      ticketId: clarification.ticketId ?? undefined,
      agentId: agent.id,
      actor: agent.name,
      action: "clarification_escalated",
      detail: note,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Klärung ${clarificationId} konnte nicht geprüft werden: ${message}`);
  }
};

export default clarificationTriage;
