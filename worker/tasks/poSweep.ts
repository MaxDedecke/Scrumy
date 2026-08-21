// Der Auftraggeber stößt den Product Owner von Hand an: „Schau dir das
// Projekt an und schaff Klarheit."
//
// Anders als jede andere Klärung entsteht dieser Job nicht aus einer
// Sackgasse, an der das Team hängengeblieben ist (siehe worker/clarification.ts),
// sondern auf Zuruf – gedacht für den Moment, in dem der Auftraggeber selbst
// den Eindruck hat, im Projekt sei etwas undefiniert liegen geblieben (ein
// Ticket ohne erkennbaren Fortschritt, ein Sprint ohne klares Ziel,
// widersprüchliche Beschlüsse, …), ohne dass er den Finger genau draufhalten
// kann.
//
// Der Product Owner löst inhaltlich nichts direkt auf – er liest
// Beschlussregister, offene Klärungen und Board wie ein Kollege, der neu
// draufschaut, und meldet, was er an UNKLAREM findet, GENAUSO wie jede andere
// Klärung auch (`openClarification`): mit Vorbereitung durch den Scrum Master
// und Prüfung durch ihn selbst danach (clarificationPrep/-Triage). So landet
// nur, was wirklich einen Blick braucht, am Ende beim Menschen – der Rest
// entscheidet das Team unterwegs selbst, wie bei jeder anderen Klärung.
//
// Unklarheit ist aber nicht der einzige Grund, warum ein Projekt steht: eine
// Job-Sperre eines abgestürzten Workers (siehe worker/reconcile.ts) oder eine
// andere Lücke in der Ablaufkette kann das Team lahmlegen, OHNE dass irgendwo
// eine Klärung offen ist – reine Diagnose findet das nicht, weil nichts
// fachlich unklar ist. Deshalb stößt dieser Task am Ende zusätzlich denselben
// Schritt an wie der „Macht weiter"-Knopf (`scheduleNextStep`) – das
// „Anstupsen" des Product Owners darf nicht nur reden, sondern muss eine
// tatsächlich liegengebliebene Arbeit auch wieder in Gang setzen.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { AGENT_ROLE_LABEL } from "@/lib/labels";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { openClarification } from "../clarification";
import type { PoSweepPayload } from "../taskTypes";
import type { ClarificationScope } from "@/generated/prisma/client";
import { scheduleNextStep } from "@/lib/nextStep";

/// Mehr Fundstellen als das würden das Büro fluten statt Klarheit zu schaffen –
/// wirklich Dringendes fällt so oder so zuerst auf.
const MAX_FINDINGS = 5;

const poSweep: Task<"poSweep"> = async (payload: PoSweepPayload, helpers) => {
  const { agentId, projectId } = payload;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const role = `${agent.name} (${AGENT_ROLE_LABEL[agent.role]})`;

  const [context, currentSprint, openExisting, tickets] = await Promise.all([
    buildProjectContext(projectId, { includeRepo: false }),
    prisma.sprint.findFirst({ where: { projectId }, orderBy: { number: "desc" } }),
    prisma.clarification.findMany({ where: { projectId, status: "OPEN" }, select: { ticketId: true, scope: true } }),
    prisma.ticket.findMany({ where: { projectId }, select: { id: true, title: true } }),
  ]);

  // Ein Bereich, der schon eine offene Klärung hat, braucht keine zweite –
  // sonst haeuft ein wiederholter Anstoss dieselbe Unklarheit mehrfach auf.
  const alreadyOpen = new Set(
    openExisting.map((entry) => `${entry.scope}:${entry.ticketId ?? "-"}`),
  );

  try {
    const { text } = await runAgent({
      agent,
      projectId,
      kind: "po_sweep",
      headline: "Prüft das Projekt auf unklare oder undefinierte Zustände",
      maxTokens: 2000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Product Owner. Der Auftraggeber hat dich ausdrücklich gebeten, das Projekt auf unklare oder undefinierte Zustände zu prüfen und Ordnung zu schaffen – nicht aus einem konkreten Anlass, sondern präventiv, weil im laufenden Betrieb Unklarheiten liegenbleiben können, ohne dass je jemand eine Klärung eröffnet hat. Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${context}

# Auftrag
Sieh dir Beschlussregister, offene Klärungen und das Scrum-Board an und suche gezielt nach Stellen, die unklar oder undefiniert sind, zum Beispiel:
- ein Ticket, dessen Status oder Zuschnitt nicht mehr zum Rest passt (lange ohne erkennbaren Fortschritt, ohne zuständige Rolle, oder dessen Titel nicht mehr zum aktuellen Sprintziel passt)
- ein Widerspruch zwischen zwei Beschlüssen, oder ein Beschluss, der dem aktuellen Board-Stand widerspricht
- ein Sprint ohne erkennbares Ziel, oder ein Ziel, das die vorhandenen Tickets nicht mehr abdecken
- ein Bereich, an dem das Board schon arbeitet, zu dem es aber weder Anforderung noch Beschluss gibt

Bereits offene Klärungen sind schon erkannt – wiederhole sie nicht. Erfinde kein Problem, wo keins ist: Ist die Lage klar, sag das kurz und liefere eine leere Liste.

Für jeden Punkt, den du findest, formulierst du eine Frage wie bei einer Klärung – Scrumy legt sie danach genauso an, mit Vorbereitung durch den Scrum Master und Prüfung durch dich selbst, wie jede andere Klärung auch. Du musst hier nichts selbst entscheiden.

Antworte nur mit diesem JSON-Objekt:
{
  "befund": "ein bis zwei Sätze Gesamteinschätzung, auch wenn punkte leer ist",
  "punkte": [
    {
      "frage": "kurze, klare Frage oder Feststellung",
      "kontext": "ein bis drei Sätze, was konkret unklar ist und woran du das siehst",
      "bezug": "TICKET oder SPRINT oder PROJEKT",
      "ticket": "nur bei bezug=TICKET: der Ticket-Titel wortgleich aus dem Board"
    }
  ]
}`,
    });

    const parsed = extractJsonObject(text);
    const befund = typeof parsed.befund === "string" ? parsed.befund.trim().slice(0, 600) : "";
    const rawFindings = Array.isArray(parsed.punkte) ? parsed.punkte.slice(0, MAX_FINDINGS) : [];

    let raised = 0;
    let skipped = 0;

    for (const entry of rawFindings) {
      const item = entry as { frage?: unknown; kontext?: unknown; bezug?: unknown; ticket?: unknown };
      const question = typeof item.frage === "string" ? item.frage.trim().slice(0, 2000) : "";
      if (!question) continue;

      const scope = normalizeScope(item.bezug);
      const ticketTitle = typeof item.ticket === "string" ? item.ticket.trim() : "";
      const ticket =
        scope === "TICKET" && ticketTitle
          ? tickets.find((candidate) => candidate.title.toLowerCase() === ticketTitle.toLowerCase())
          : undefined;

      // Auf TICKET verwiesen, aber kein Ticket im Board gefunden: Dann ist der
      // Bezug nicht belastbar – lieber als Projekt-Punkt anlegen als an ein
      // falsches Ticket haengen.
      const resolvedScope: ClarificationScope = scope === "TICKET" && !ticket ? "PROJECT" : scope;
      const ticketId = resolvedScope === "TICKET" ? (ticket?.id ?? null) : null;
      const sprintId = resolvedScope === "SPRINT" ? (currentSprint?.id ?? null) : null;

      const dedupeKey = `${resolvedScope}:${ticketId ?? "-"}`;
      if (alreadyOpen.has(dedupeKey)) {
        skipped += 1;
        continue;
      }
      alreadyOpen.add(dedupeKey);

      await openClarification({
        projectId,
        scope: resolvedScope,
        trigger: `po_sweep:${slug(question)}`,
        question,
        context: typeof item.kontext === "string" ? item.kontext.trim().slice(0, 2000) : null,
        ticketId,
        sprintId,
        raisedById: agent.id,
      });
      raised += 1;
    }

    const detail =
      raised === 0
        ? befund || "Keine Unklarheiten gefunden – das Projekt ist aus meiner Sicht in Ordnung."
        : `${befund ? `${befund} ` : ""}${raised} ${raised === 1 ? "Klärung" : "Klärungen"} eingereicht${
            skipped > 0 ? ` (${skipped} weitere waren schon offen)` : ""
          }.`;

    await logActivity({
      projectId,
      agentId: agent.id,
      actor: agent.name,
      action: "po_sweep_completed",
      detail: detail.slice(0, 600),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Klarheits-Check von ${role} ist fehlgeschlagen: ${message}`);
    await logActivity({
      projectId,
      agentId: agent.id,
      actor: agent.name,
      action: "po_sweep_completed",
      detail: `Konnte das Projekt nicht prüfen (${message.slice(0, 200)}).`,
    });
  }

  // Diagnose allein bewegt nichts – siehe Kommentar am Dateikopf. Läuft
  // unabhängig davon, ob der Klarheits-Check oben geklappt hat: Scheitert
  // der Modellaufruf (z.B. Anbieter überlastet), soll das Team trotzdem
  // nicht stehen bleiben. Arbeitet gerade schon jemand, ist hier nichts zu
  // tun – die Prüfung ist nur, um im Log nicht staendig ein folgenloses
  // "nächster Schritt: läuft schon" zu vermelden. Ein zusätzliches,
  // unabhängiges zweites Ticket (Parallel-Modus, siehe `Project.workMode`)
  // startet ausschließlich der periodische Scrum-Master-Check
  // (worker/tasks/parallelCheck.ts) mit seiner eigenen, genaueren
  // Unabhängigkeits-Prüfung – hier reicht "läuft schon irgendwas".
  const alreadyRunning = await prisma.agentRun.findFirst({ where: { projectId, status: "RUNNING" } });
  if (!alreadyRunning) {
    try {
      const resumeMessage = await scheduleNextStep(projectId);
      await logActivity({
        projectId,
        agentId: agent.id,
        actor: agent.name,
        action: "po_sweep_resumed",
        detail: resumeMessage.slice(0, 600),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      helpers.logger.error(`Wiederaufnahme durch ${role} ist fehlgeschlagen: ${message}`);
    }
  }
};

function normalizeScope(value: unknown): ClarificationScope {
  const text = String(value ?? "").trim().toUpperCase();
  if (text === "TICKET" || text === "SPRINT" || text === "PROJECT" || text === "PROJEKT") {
    return text === "PROJEKT" ? "PROJECT" : (text as ClarificationScope);
  }
  return "PROJECT";
}

/// Entdopplungsschlüssel aus der Frage – grob, aber genug, um denselben
/// Wortlaut nicht zweimal als Klärung anzulegen (siehe `openClarification`,
/// die zusätzlich nach Ticket und Status entdoppelt).
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export default poSweep;
