import type { AgentStatus, Priority, TicketStatus, TicketType } from "@/generated/prisma/client";

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
