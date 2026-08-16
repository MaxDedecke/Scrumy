import type {
  AgentRole,
  AgentStatus,
  ConnectorProvider,
  ConnectorStatus,
  Priority,
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

export const PRIORITY_COLOR: Record<Priority, string> = {
  LOW: "bg-neutral-700 text-neutral-200",
  MEDIUM: "bg-sky-900 text-sky-200",
  HIGH: "bg-amber-900 text-amber-200",
  URGENT: "bg-red-900 text-red-200",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  IDLE: "Bereit",
  WORKING: "Arbeitet",
  BLOCKED: "Blockiert",
};

export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  IDLE: "bg-neutral-700 text-neutral-200",
  WORKING: "bg-emerald-900 text-emerald-200",
  BLOCKED: "bg-red-900 text-red-200",
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

export const SUPPORT_REQUEST_STATUS_COLOR: Record<SupportRequestStatus, string> = {
  NEW: "bg-sky-900 text-sky-200",
  TRIAGED: "bg-amber-900 text-amber-200",
  CONVERTED: "bg-emerald-900 text-emerald-200",
  CLOSED: "bg-neutral-700 text-neutral-200",
};

export const CONNECTOR_PROVIDER_LABEL: Record<ConnectorProvider, string> = {
  JIRA: "Jira",
  ZENDESK: "Zendesk",
  EMAIL: "E-Mail",
  GENERIC_WEBHOOK: "Webhook",
};

export const CONNECTOR_STATUS_COLOR: Record<ConnectorStatus, string> = {
  ACTIVE: "bg-emerald-900 text-emerald-200",
  INACTIVE: "bg-neutral-700 text-neutral-200",
  ERROR: "bg-red-900 text-red-200",
};
