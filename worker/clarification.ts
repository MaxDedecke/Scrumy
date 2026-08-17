// Wenn das Team nicht weiterweiß: einberufen statt stehenbleiben.
//
// Vorher endete jede Sackgasse gleich – ein Eintrag im Protokoll, und die
// Arbeit stand. Ein zweimal am Modell gescheiterter Umsetzungsschritt, ein
// Ticket ohne zuständige Rolle, ein leerer Backlog: In allen Fällen wusste
// niemand, dass das Team wartet, und nur ein Eingriff von Hand brachte es
// wieder in Gang.
//
// Diese Datei ist die Gegenmaßnahme. `openClarification` verwandelt eine
// Sackgasse in einen Vorgang mit Frage, Optionen und – entscheidend – dem
// eingefrorenen Arbeitsschritt, der nach dem Beschluss genau dort weiterläuft,
// wo es hakte. Der Mensch entscheidet im Team-Büro, der Beschluss landet im
// Beschlussregister und damit in jedem weiteren Prompt (siehe
// worker/projectContext.ts), damit dieselbe Frage nicht in vier Wochen erneut
// aufläuft.
import { prisma } from "@/lib/prisma";
import { agentForRole } from "@/lib/team";
import type { Clarification, ClarificationScope } from "@/generated/prisma/client";
import { withFallbackOptions, type ClarificationOption } from "@/lib/clarificationOptions";
import { enqueueAgentJob } from "./queue";

export interface OpenClarificationInput {
  projectId: string;
  scope: ClarificationScope;
  /** Anlass, zugleich Entdopplungsschlüssel: step_failed, no_changes, … */
  trigger: string;
  question: string;
  context?: string | null;
  ticketId?: string | null;
  sprintId?: string | null;
  /** Der Agent, der einberuft – null, wenn Scrumy selbst aufräumt. */
  raisedById?: string | null;
  options?: ClarificationOption[];
  /** Der Schritt, der nach dem Beschluss weiterlaufen soll. */
  resume?: { task: string; payload: unknown } | null;
  /** Agenda vom Scrum Master ausarbeiten lassen (Standard: ja). */
  prepare?: boolean;
}

/// Standardvorschläge, wenn weder Agent noch Scrum Master eigene liefern. Sie
/// sind bewusst schlicht: Die Oberfläche soll nie mit einer Frage ohne
/// Antwortmöglichkeit dastehen.
function defaultOptions(canSkipTicket: boolean): ClarificationOption[] {
  return withFallbackOptions(
    [{ key: "resume", label: "Nochmal versuchen", detail: "Das Team nimmt den Schritt erneut auf.", effect: "resume" }],
    { canSkipTicket },
  );
}

/// Beruft eine Klärung ein. Läuft für denselben Anlass schon eine offene
/// Klärung (z.B. weil ein Job mehrfach an derselben Stelle scheitert), wird
/// keine zweite angelegt – der Mensch soll eine Frage beantworten, nicht
/// fünfmal dieselbe.
export async function openClarification(input: OpenClarificationInput): Promise<Clarification> {
  const { projectId, scope, trigger, question } = input;
  const ticketId = input.ticketId ?? null;

  const existing = await prisma.clarification.findFirst({
    where: { projectId, trigger, ticketId, status: "OPEN" },
  });
  if (existing) return existing;

  // Ein zurückgestelltes Ticket gibt es nur, wenn die Klärung an einem Ticket
  // hängt – sonst wäre es ein Weg, den Scrumy gar nicht gehen kann.
  const canSkipTicket = Boolean(ticketId) && scope === "TICKET";
  const options = input.options?.length
    ? withFallbackOptions(input.options, { canSkipTicket })
    : defaultOptions(canSkipTicket);

  const clarification = await prisma.clarification.create({
    data: {
      projectId,
      ticketId,
      sprintId: input.sprintId ?? null,
      raisedById: input.raisedById ?? null,
      scope,
      trigger,
      question: question.slice(0, 2000),
      context: input.context ? input.context.slice(0, 8000) : null,
      options: options as unknown as object,
      resumeTask: input.resume?.task ?? null,
      resumePayload: (input.resume?.payload ?? undefined) as object | undefined,
    },
  });

  const raisedBy = clarification.raisedById
    ? await prisma.agent.findUnique({ where: { id: clarification.raisedById } })
    : null;

  await prisma.activityLogEntry.create({
    data: {
      projectId,
      ticketId,
      agentId: clarification.raisedById,
      actor: raisedBy?.name ?? "Scrumy",
      action: "clarification_opened",
      detail: `Klärung einberufen (${SCOPE_WORD[scope]}): ${question.slice(0, 300)}`,
    },
  });

  // Der Scrum Master bereitet die Agenda vor: Optionen mit Für und Wider,
  // damit der Mensch entscheiden kann, ohne sich erst durch Prompts und Diffs
  // zu lesen. Schlägt das fehl, bleiben die Standardvorschläge stehen – eine
  // Klärung ohne Agenda ist immer noch besser als ein stiller Stillstand.
  if (input.prepare ?? true) {
    const scrumMaster = await agentForRole(projectId, "SCRUM_MASTER");
    if (scrumMaster) {
      await enqueueAgentJob("clarificationPrep", {
        agentId: scrumMaster.id,
        projectId,
        clarificationId: clarification.id,
        reason: `Klärung vorbereiten: ${trigger}`,
      });
    }
  }

  return clarification;
}

const SCOPE_WORD: Record<ClarificationScope, string> = {
  TICKET: "betrifft ein Ticket",
  SPRINT: "betrifft den Sprint",
  PROJECT: "betrifft das Projekt",
};

/// Hält eine offene Klärung das ganze Team an? Nur `scope: PROJECT` tut das –
/// ein Impediment blockiert eine Story, nicht die Mannschaft.
export async function projectBlocker(projectId: string): Promise<Clarification | null> {
  return prisma.clarification.findFirst({
    where: { projectId, status: "OPEN", scope: "PROJECT" },
    orderBy: { createdAt: "asc" },
  });
}

/// Hält eine offene Klärung diesen Sprint an? Anders als ein blockiertes
/// Ticket legt das den ganzen Sprint still – aber nicht das Projekt: Ein
/// Kickoff oder die Planung des nächsten Sprints laufen weiter.
export async function sprintBlocker(sprintId: string): Promise<Clarification | null> {
  return prisma.clarification.findFirst({
    where: { sprintId, status: "OPEN", scope: "SPRINT" },
    orderBy: { createdAt: "asc" },
  });
}

/// Tickets, die wegen einer offenen Klärung liegen bleiben.
export async function blockedTicketIds(sprintId: string): Promise<string[]> {
  const blocked = await prisma.clarification.findMany({
    where: { status: "OPEN", ticketId: { not: null }, ticket: { sprintId } },
    select: { ticketId: true },
  });
  return blocked.map((entry) => entry.ticketId).filter((id): id is string => Boolean(id));
}
