// Der Scrum Master bereitet eine einberufene Klärung vor.
//
// Eine Frage allein hilft dem Auftraggeber wenig: „Der Schritt ist gescheitert,
// wie weiter?" verlangt von ihm, sich in Prompts, Diffs und Fehlermeldungen
// einzulesen. Also macht das Team dieselbe Vorarbeit wie vor einer echten
// Besprechung: Lage in drei Sätzen, zwei bis vier gangbare Wege mit Für und
// Wider, dazu eine Empfehlung. Entschieden wird trotzdem im Büro.
//
// Läuft bewusst ohne Rücksicht auf Blockaden und ohne eigene Klärung im
// Fehlerfall: Wenn schon die Vorbereitung scheitert (typischerweise weil
// dasselbe Modell ausgefallen ist, das die Klärung ausgelöst hat), bleiben die
// Standardvorschläge stehen. Eine Klärung ohne Agenda ist immer noch
// entscheidbar – eine Kette aus Klärungen über Klärungen wäre es nicht.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { CLARIFICATION_EFFECTS, readOptions, type ClarificationOption } from "@/lib/clarificationOptions";
import type { ClarificationPrepPayload } from "../taskTypes";

/// Mehr Wege als das macht die Entscheidung nicht besser, nur länger.
const MAX_OPTIONS = 4;

const clarificationPrep: Task<"clarificationPrep"> = async (payload: ClarificationPrepPayload, helpers) => {
  const { agentId, projectId, clarificationId } = payload;

  const clarification = await prisma.clarification.findUnique({
    where: { id: clarificationId },
    include: { ticket: true, raisedBy: true },
  });
  if (!clarification || clarification.status !== "OPEN") return;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const fallback = readOptions(clarification.options);

  try {
    const context = await buildProjectContext(projectId, { includeRepo: false });
    const { text } = await runAgent({
      agent,
      projectId,
      ticketId: clarification.ticketId ?? undefined,
      sprintId: clarification.sprintId ?? undefined,
      kind: "clarification_prep",
      headline: `Bereitet eine Klärung vor: „${clarification.question.slice(0, 80)}"`,
      maxTokens: 3000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Scrum Master. Das Team ist an einer Stelle nicht weitergekommen und hat den Auftraggeber einberufen. Du bereitest die Entscheidung vor, du triffst sie nicht. Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${context}

# Die Klärung
Einberufen von: ${clarification.raisedBy?.name ?? "Scrumy (automatisch)"}
Anlass: ${clarification.trigger}
${clarification.ticket ? `Betroffenes Ticket: ${clarification.ticket.title}\n` : ""}Frage: ${clarification.question}

## Was passiert ist
${clarification.context ?? "(nichts weiter protokolliert)"}

Bereite die Entscheidung vor. Beschreibe die Lage in höchstens drei Sätzen, so wie du sie dem Auftraggeber im Büro erklären würdest – ohne Fachjargon, ohne Schuldzuweisung. Schlage dann zwei bis ${MAX_OPTIONS} Wege vor, die das Team tatsächlich gehen kann, und sag am Ende, wozu du rätst und warum.

Jeder Weg braucht eine Wirkung ("effect"), damit Scrumy den Beschluss ausführen kann:
- "resume": Das Team nimmt den unterbrochenen Schritt wieder auf (ggf. mit deiner Vorgabe).
- "skip": Das betroffene Ticket geht zurück in den Backlog, der Sprint läuft ohne es weiter.
- "stop": Das Team hält an und wartet auf den Auftraggeber.
- "budget": Nur wenn es um die Sprint-Obergrenze geht – Budget aufstocken und weiterarbeiten.

Antworte nur mit diesem JSON-Objekt:
{
  "lage": "höchstens drei Sätze",
  "optionen": [
    { "label": "kurzer Titel des Wegs", "detail": "was das konkret heißt, mit Für und Wider in 1-2 Sätzen", "effect": "resume | skip | stop | budget" }
  ],
  "empfehlung": "Welchen Weg du empfiehlst und warum – ein bis zwei Sätze."
}`,
    });

    const parsed = extractJsonObject(text);
    const options = normalizeOptions(parsed.optionen, fallback);
    const situation = String(parsed.lage ?? "").trim();
    const recommendation = String(parsed.empfehlung ?? "").trim();
    const agenda = [situation, recommendation ? `**Empfehlung:** ${recommendation}` : ""]
      .filter(Boolean)
      .join("\n\n");

    // `updateMany` statt `update`: Hat der Mensch in der Zwischenzeit schon
    // entschieden, darf die Agenda den Beschluss nicht mehr anfassen.
    await prisma.clarification.updateMany({
      where: { id: clarificationId, status: "OPEN" },
      data: { agenda: agenda || null, options: options as unknown as object },
    });

    await logActivity({
      projectId,
      ticketId: clarification.ticketId ?? undefined,
      agentId: agent.id,
      actor: agent.name,
      action: "clarification_prepared",
      detail: `Entscheidungsvorlage für „${clarification.question.slice(0, 160)}" (${options.length} Wege)`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Klärung ${clarificationId} konnte nicht vorbereitet werden: ${message}`);
    await logActivity({
      projectId,
      ticketId: clarification.ticketId ?? undefined,
      agentId: agent.id,
      actor: agent.name,
      action: "clarification_prep_failed",
      detail: `Entscheidungsvorlage nicht erstellt (${message.slice(0, 200)}) – die Frage steht trotzdem im Büro.`,
    });
  }
};

/// Aus der Modellantwort werden geprüfte Optionen. Kommt nichts Brauchbares
/// zurück, bleiben die Standardvorschläge – nie eine Frage ohne Antwortweg.
function normalizeOptions(value: unknown, fallback: ClarificationOption[]): ClarificationOption[] {
  if (!Array.isArray(value)) return fallback;

  const options: ClarificationOption[] = [];
  for (const entry of value.slice(0, MAX_OPTIONS)) {
    const item = entry as { label?: unknown; detail?: unknown; effect?: unknown };
    const label = String(item.label ?? "").trim();
    if (!label) continue;
    const effect = String(item.effect ?? "").trim().toLowerCase();
    options.push({
      key: `option-${options.length + 1}`,
      label: label.slice(0, 160),
      detail: typeof item.detail === "string" ? item.detail.slice(0, 600) : undefined,
      effect: CLARIFICATION_EFFECTS.includes(effect as ClarificationOption["effect"])
        ? (effect as ClarificationOption["effect"])
        : "resume",
    });
  }

  if (options.length === 0) return fallback;

  // Der Ausstieg muss immer wählbar bleiben, auch wenn das Modell ihn vergisst:
  // Der Mensch darf das Team jederzeit anhalten statt nur zwischen zwei
  // Weiterarbeits-Varianten zu wählen.
  if (!options.some((option) => option.effect === "stop")) {
    options.push({
      key: `option-${options.length + 1}`,
      label: "Team anhalten",
      detail: "Niemand arbeitet weiter, bis du den nächsten Schritt anstößt.",
      effect: "stop",
    });
  }

  return options;
}

export default clarificationPrep;
