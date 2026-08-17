// Zentrale Task-Registry fuer graphile-worker – die Schritte, die das
// Agenten-Team ausfuehren kann. Die Payload-Typen stehen in `../taskTypes.ts`,
// damit auch die Next.js-App Jobs einreihen kann, ohne den Worker-Code zu
// laden.
//
// Ablauf: teamKickoff -> sprintPlanning -> ticketWork (je Ticket) ->
// sprintReview -> (Autopilot) sprintPlanning. teamInquiry laeuft unabhaengig
// davon, sobald der Mensch etwas wissen will, clarificationPrep, sobald das
// Team eine Klaerung einberufen hat.
//
// Jeder Schritt der Arbeitskette laeuft durch `withClarification`: Gibt ein
// Job endgueltig auf, endet das nicht mehr in einem stillen Stillstand,
// sondern in einer Klaerung mit dem eingefrorenen Schritt im Gepaeck.
import type { Task, TaskList } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import "../taskTypes";
import { AgentRunError } from "../agentRun";
import { openClarification } from "../clarification";
import teamKickoff from "./teamKickoff";
import sprintPlanning from "./sprintPlanning";
import ticketWork from "./ticketWork";
import sprintReview from "./sprintReview";
import teamInquiry from "./teamInquiry";
import clarificationPrep from "./clarificationPrep";
import clarificationTriage from "./clarificationTriage";

/// Woran der Mensch im Buero erkennt, welcher Schritt gescheitert ist.
const STEP_LABEL: Record<string, string> = {
  teamKickoff: "Auftrag lesen und Arbeitsplatz einrichten",
  sprintPlanning: "Sprint-Planung",
  ticketWork: "Ticket-Bearbeitung",
  sprintReview: "Sprint-Review",
};

/// Felder, die alle Payloads der Arbeitskette gemeinsam haben.
interface ChainPayload {
  projectId?: string;
  ticketId?: string;
  sprintId?: string;
  agentId?: string;
}

/// Umschlag um einen Task: Scheitert er endgueltig (letzter Versuch
/// aufgebraucht), beruft das Team eine Klaerung ein, statt die Kette
/// abreissen zu lassen.
///
/// Warum hier und nicht in jedem Task einzeln: Ein Absturz kann an jeder Zeile
/// passieren – im Modellaufruf, beim Schreiben ins Repo, in der Datenbank. Nur
/// eine Klammer um den ganzen Schritt faengt sie alle. Der Fehler wird danach
/// weitergeworfen, damit der Job in der Queue korrekt als gescheitert gilt.
function withClarification<TIdentifier extends keyof GraphileWorker.Tasks>(
  identifier: TIdentifier,
  task: Task<TIdentifier>,
): Task<TIdentifier> {
  return async (payload, helpers) => {
    try {
      await task(payload, helpers);
    } catch (error) {
      const isLastAttempt = helpers.job.attempts >= helpers.job.max_attempts;
      const chain = (payload ?? {}) as ChainPayload;

      if (isLastAttempt && chain.projectId) {
        // Scheitert auch das Einberufen (typischerweise weil die Datenbank
        // selbst der Grund fuer den Absturz war), darf das den urspruenglichen
        // Fehler nicht verdecken – der steht sonst nicht mehr in der Queue.
        try {
          await raiseClarification(identifier, chain.projectId, payload, error);
        } catch (clarificationError) {
          helpers.logger.error(
            `Klärung konnte nicht einberufen werden: ${
              clarificationError instanceof Error ? clarificationError.message : String(clarificationError)
            }`,
          );
        }
      }

      throw error;
    }
  };
}

/// Der Vorgang, aus dem ein endgueltig gescheiterter Schritt eine Frage an den
/// Auftraggeber wird – mit dem Job im Gepaeck, der danach weiterlaufen soll.
async function raiseClarification(
  identifier: string,
  projectId: string,
  /// Der Payload geht unveraendert in die Klaerung – nur mit ihm kann der
  /// Schritt spaeter genau dort weiterlaufen, wo er abgebrochen ist.
  payload: unknown,
  error: unknown,
): Promise<void> {
  const chain = (payload ?? {}) as ChainPayload;
  const message = error instanceof Error ? error.message : String(error);
  const tokenLimit = error instanceof AgentRunError && error.code === "TOKEN_LIMIT";
  const ticket = chain.ticketId
    ? await prisma.ticket.findUnique({ where: { id: chain.ticketId }, select: { title: true } })
    : null;
  const step = STEP_LABEL[identifier] ?? identifier;

  await openClarification({
    projectId,
    // Ein gescheitertes Ticket legt nur dieses Ticket still; alles andere
    // trifft den ganzen Arbeitsstrang.
    scope: chain.ticketId ? "TICKET" : "PROJECT",
    trigger: "step_failed",
    ticketId: chain.ticketId ?? null,
    sprintId: chain.sprintId ?? null,
    raisedById: chain.agentId ?? null,
    question: ticket
      ? tokenLimit
        ? `„${ticket.title}": Der Arbeitsschritt ist trotz automatischer Verkleinerung am Token-Limit gescheitert.`
        : `„${ticket.title}": Die Umsetzung ist auch im letzten Anlauf abgebrochen. Wie sollen wir weitermachen?`
      : `Der Schritt „${step}" ist auch im letzten Anlauf abgebrochen. Wie sollen wir weitermachen?`,
    context: `Schritt: ${step}\nAbbruchgrund: ${message}`,
    options: tokenLimit
      ? [
          {
            key: "resume",
            label: "Erneut technisch zerlegen",
            detail: "Scrumy versucht den Schritt nochmals mit dem kompakten Kontext- und Zerlegungsweg.",
            effect: "resume",
          },
          { key: "stop", label: "Team anhalten", effect: "stop" },
        ]
      : undefined,
    resume: { task: identifier, payload },
    // Zu einem technischen Limit soll der Scrum Master keine vermeintlich
    // fachlichen Wege oder nicht konfigurierte Modellwechsel erfinden.
    prepare: !tokenLimit,
  });
}

export const taskList: TaskList = {
  teamKickoff: withClarification("teamKickoff", teamKickoff) as Task,
  sprintPlanning: withClarification("sprintPlanning", sprintPlanning) as Task,
  ticketWork: withClarification("ticketWork", ticketWork) as Task,
  sprintReview: withClarification("sprintReview", sprintReview) as Task,
  // Bewusst ohne Umschlag: Eine unbeantwortete Rueckfrage steht sichtbar im
  // Buero, und eine gescheiterte Entscheidungsvorlage oder -pruefung darf
  // keine zweite Klaerung ausloesen.
  teamInquiry: teamInquiry as Task,
  clarificationPrep: clarificationPrep as Task,
  clarificationTriage: clarificationTriage as Task,
};
