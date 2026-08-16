import type {
  AgentRole,
  AgentStatus,
  InquiryStatus,
  RunStatus,
  SprintStatus,
  ConceptStatus,
  ConnectorProvider,
  ConnectorStatus,
  LlmProvider,
  Priority,
  ProjectStatus,
  RequirementSource,
  SupportChannel,
  SupportRequestStatus,
  TicketStatus,
  TicketType,
} from "@/generated/prisma/client";

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  BACKLOG: "Backlog",
  IN_PROGRESS: "In Arbeit",
  IN_REVIEW: "In Review",
  DONE: "Fertig",
};

export const TICKET_STATUS_ORDER: TicketStatus[] = [
  "BACKLOG",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
];

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  FEATURE: "Feature",
  BUG: "Bug",
  INTEGRATION: "Integration",
  CHORE: "Chore",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: "Niedrig",
  MEDIUM: "Mittel",
  HIGH: "Hoch",
  URGENT: "Dringend",
};

// Status-Palette statt Kategorienfarben: Dringlichkeit ist ein Zustand, keine Identität.
export const PRIORITY_PILL: Record<Priority, string> = {
  LOW: "pill pill-neutral",
  MEDIUM: "pill pill-info",
  HIGH: "pill pill-warning",
  URGENT: "pill pill-critical",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  IDLE: "Bereit",
  WORKING: "Arbeitet",
  BLOCKED: "Blockiert",
};

export const AGENT_STATUS_PILL: Record<AgentStatus, string> = {
  IDLE: "pill pill-neutral",
  WORKING: "pill pill-good",
  BLOCKED: "pill pill-critical",
};

// Pipeline-Reihenfolge: SUPPORT -> PRODUCT_OWNER -> PLANNING -> Coding-Agenten.
export const AGENT_ROLE_LABEL: Record<AgentRole, string> = {
  SUPPORT: "Support",
  PRODUCT_OWNER: "Product Owner",
  PLANNING: "Planning",
  BACKEND: "Backend",
  FRONTEND: "Frontend",
  QA: "QA",
  REVIEWER: "Reviewer",
  DEVOPS: "DevOps",
  SCRUM_MASTER: "Scrum Master",
};

export const SUPPORT_CHANNEL_LABEL: Record<SupportChannel, string> = {
  EMAIL: "E-Mail",
  JIRA: "Jira",
  CHAT: "Chat",
  PORTAL: "Kundenportal",
  PHONE_NOTE: "Telefonnotiz",
};

export const SUPPORT_REQUEST_STATUS_LABEL: Record<SupportRequestStatus, string> = {
  NEW: "Neu",
  TRIAGED: "Triagiert",
  CONVERTED: "In Ticket überführt",
  CLOSED: "Geschlossen",
};

export const SUPPORT_REQUEST_STATUS_PILL: Record<SupportRequestStatus, string> = {
  NEW: "pill pill-info",
  TRIAGED: "pill pill-warning",
  CONVERTED: "pill pill-good",
  CLOSED: "pill pill-neutral",
};

export const CONNECTOR_PROVIDER_LABEL: Record<ConnectorProvider, string> = {
  JIRA: "Jira",
  ZENDESK: "Zendesk",
  EMAIL: "E-Mail",
  GIT: "Git",
  GENERIC_WEBHOOK: "Webhook",
};

export const CONNECTOR_STATUS_LABEL: Record<ConnectorStatus, string> = {
  ACTIVE: "Aktiv",
  INACTIVE: "Inaktiv",
  ERROR: "Fehler",
};

export const CONNECTOR_STATUS_PILL: Record<ConnectorStatus, string> = {
  ACTIVE: "pill pill-good",
  INACTIVE: "pill pill-neutral",
  ERROR: "pill pill-critical",
};

// Lebenszyklus: DISCOVERY -> CONCEPT -> ACTIVE (Team gestartet) -> PAUSED/ARCHIVED.
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  DISCOVERY: "Discovery",
  CONCEPT: "Konzeptphase",
  ACTIVE: "Aktiv",
  PAUSED: "Pausiert",
  ARCHIVED: "Archiviert",
};

export const PROJECT_STATUS_PILL: Record<ProjectStatus, string> = {
  DISCOVERY: "pill pill-neutral",
  CONCEPT: "pill pill-info",
  ACTIVE: "pill pill-good",
  PAUSED: "pill pill-warning",
  ARCHIVED: "pill pill-neutral",
};

export const REQUIREMENT_SOURCE_LABEL: Record<RequirementSource, string> = {
  MANUAL: "Manuell",
  UPLOAD: "Hochgeladen",
  GENERATED: "KI-generiert",
};

// Generierte Anforderungen heben sich ab, damit man sieht, was noch zu prüfen ist.
export const REQUIREMENT_SOURCE_PILL: Record<RequirementSource, string> = {
  MANUAL: "pill pill-neutral",
  UPLOAD: "pill pill-neutral",
  GENERATED: "pill pill-info",
};

export const CONCEPT_STATUS_LABEL: Record<ConceptStatus, string> = {
  DRAFT: "Entwurf",
  FINALIZED: "Freigegeben",
};

export const CONCEPT_STATUS_PILL: Record<ConceptStatus, string> = {
  DRAFT: "pill pill-neutral",
  FINALIZED: "pill pill-good",
};

export const LLM_PROVIDER_LABEL: Record<LlmProvider, string> = {
  ANTHROPIC: "Anthropic (Cloud)",
  OPENAI: "OpenAI (Cloud)",
  OLLAMA: "Ollama (lokal)",
  GENERIC_OPENAI_COMPAT: "OpenAI-kompatibel (Cloud/Self-Hosted)",
};

// Sprint-Lebenszyklus: geplant -> laeuft -> Review -> abgeschlossen.
export const SPRINT_STATUS_LABEL: Record<SprintStatus, string> = {
  PLANNED: "Geplant",
  ACTIVE: "Läuft",
  REVIEW: "Im Review",
  DONE: "Abgeschlossen",
};

export const SPRINT_STATUS_PILL: Record<SprintStatus, string> = {
  PLANNED: "pill pill-neutral",
  ACTIVE: "pill pill-good",
  REVIEW: "pill pill-info",
  DONE: "pill pill-neutral",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  RUNNING: "Läuft",
  SUCCEEDED: "Erledigt",
  FAILED: "Fehlgeschlagen",
};

export const RUN_STATUS_PILL: Record<RunStatus, string> = {
  RUNNING: "pill pill-info",
  SUCCEEDED: "pill pill-good",
  FAILED: "pill pill-critical",
};

// Was ein Agentenlauf war – dieselben Schluessel wie `AgentRun.kind`.
export const RUN_KIND_LABEL: Record<string, string> = {
  kickoff: "Auftrag verstehen",
  sprint_planning: "Sprint-Planung",
  ticket_plan: "Ticket-Planung",
  implementation: "Umsetzung",
  review: "QA-Review",
  sprint_review: "Sprint-Review",
  inquiry: "Rückfrage beantwortet",
};

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  PENDING: "Wird beantwortet",
  ANSWERED: "Beantwortet",
  FAILED: "Fehlgeschlagen",
};

// Protokoll-Aktionen im Klartext. Unbekannte Schluessel zeigt die Oberflaeche
// unveraendert an – lieber ein technischer Name als eine falsche Uebersetzung.
export const ACTIVITY_ACTION_LABEL: Record<string, string> = {
  team_started: "Team gestartet",
  team_paused: "Arbeit angehalten",
  team_resumed: "Arbeit fortgesetzt",
  team_waiting: "Team wartet",
  team_blocked: "Team blockiert",
  team_halted: "Team angehalten",
  autopilot_on: "Autopilot an",
  autopilot_off: "Autopilot aus",
  repo_created: "Repository angelegt",
  repo_reused: "Repository weiterverwendet",
  kickoff_completed: "Auftrag verstanden",
  sprint_planned: "Sprint geplant",
  sprint_reviewed: "Sprint abgeschlossen",
  backlog_empty: "Backlog leer",
  ticket_started: "Ticket übernommen",
  ticket_planned: "Ticket geplant",
  ticket_reworked: "Nacharbeit",
  ticket_done: "Ticket fertig",
  ticket_without_changes: "Keine Änderung geliefert",
  code_committed: "Commit",
  review_approved: "QA freigegeben",
  review_rework: "QA: Nacharbeit",
  human_review_requested: "Freigabe angefragt",
  human_approved: "Vom Menschen freigegeben",
  human_rejected: "Vom Menschen zurückgewiesen",
  inquiry_answered: "Rückfrage beantwortet",
  step_failed: "Schritt fehlgeschlagen",
  files_rejected: "Dateien abgelehnt",
  step_abandoned: "Abgebrochener Schritt aufgeräumt",
  concept_released: "Konzept freigegeben",
  concept_reopened: "Konzept-Freigabe zurückgezogen",
  concept_template_applied: "Konzept-Vorlage eingefügt",
  requirements_generated: "Anforderungen generiert",
  requirements_approved: "Anforderungen freigegeben",
  requirements_reopened: "Anforderungs-Freigabe zurückgezogen",
};
