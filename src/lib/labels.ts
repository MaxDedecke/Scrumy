import type {
  AgentRole,
  AgentStatus,
  ConnectorProvider,
  ConnectorStatus,
  LlmProvider,
  Priority,
  ProjectStatus,
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

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  ACTIVE: "Aktiv",
  PAUSED: "Pausiert",
  ARCHIVED: "Archiviert",
};

export const LLM_PROVIDER_LABEL: Record<LlmProvider, string> = {
  ANTHROPIC: "Anthropic (Cloud)",
  OPENAI: "OpenAI (Cloud)",
  OLLAMA: "Ollama (lokal)",
  GENERIC_OPENAI_COMPAT: "OpenAI-kompatibel (Cloud/Self-Hosted)",
};
