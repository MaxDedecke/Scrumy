// Payload-Typen aller Agenten-Jobs, getrennt von den Task-Implementierungen.
//
// Grund fuer die Trennung: Auch die Next.js-App reiht Jobs ein (Team starten,
// Rueckfrage stellen). Ueber diese Datei bekommt sie die Typen, ohne den
// kompletten Worker-Code samt Git-/Dateisystem-Zugriff mitzuziehen.

/** Erster Arbeitstag: Repo anlegen, Auftrag lesen, Verständnis dokumentieren. */
export interface TeamKickoffPayload {
  agentId: string;
  projectId: string;
  reason: string;
}

/** Product Owner schneidet den nächsten Sprint aus Konzept + Anforderungen. */
export interface SprintPlanningPayload {
  agentId: string;
  projectId: string;
  reason: string;
}

/** Ein Ticket komplett durcharbeiten: planen, umsetzen, review. */
export interface TicketWorkPayload {
  agentId: string;
  projectId: string;
  ticketId: string;
  reason: string;
  /** Wievielter Umsetzungsanlauf (nach einem Review mit Nacharbeit). */
  attempt?: number;
}

/** Sprint abschließen: Zusammenfassung schreiben, ggf. nächsten Sprint starten. */
export interface SprintReviewPayload {
  agentId: string;
  projectId: string;
  sprintId: string;
  reason: string;
}

/** Rückfrage des Menschen ans Team beantworten. */
export interface TeamInquiryPayload {
  agentId: string;
  projectId: string;
  inquiryId: string;
  reason: string;
}

/** Agenda für eine einberufene Klärung ausarbeiten (Optionen mit Für und Wider). */
export interface ClarificationPrepPayload {
  agentId: string;
  projectId: string;
  clarificationId: string;
  reason: string;
}

/** Product Owner prüft eine vorbereitete Klärung: selbst entscheiden oder dem
 *  Auftraggeber vorlegen (siehe worker/tasks/clarificationTriage.ts). */
export interface ClarificationTriagePayload {
  agentId: string;
  projectId: string;
  clarificationId: string;
  reason: string;
}

declare global {
  // Von graphile-worker vorgegebener Mechanismus fuer typisierte Task-Payloads
  // (Declaration Merging), kein selbst gewaehltes Namespace-Pattern.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace GraphileWorker {
    interface Tasks {
      teamKickoff: TeamKickoffPayload;
      sprintPlanning: SprintPlanningPayload;
      ticketWork: TicketWorkPayload;
      sprintReview: SprintReviewPayload;
      teamInquiry: TeamInquiryPayload;
      clarificationPrep: ClarificationPrepPayload;
      clarificationTriage: ClarificationTriagePayload;
    }
  }
}
