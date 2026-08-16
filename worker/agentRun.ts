// Jeder Denk-/Arbeitsschritt eines Agenten laeuft durch diese eine Funktion.
//
// Sie ist der Grund, warum das Team spaeter Rechenschaft ablegen kann: Vor dem
// Modellaufruf entsteht ein `AgentRun` mit Systemprompt, Prompt und Modell,
// danach kommen Antwort, Dauer und Status dazu – auch im Fehlerfall. Nichts,
// was ein Agent tut, passiert damit ohne Beleg. Gleichzeitig haengt hier der
// sichtbare Agentenstatus (IDLE/WORKING) und das Rate-Limit pro LLM-Profil.
import { prisma } from "@/lib/prisma";
import { chat, LlmError } from "@/lib/llm";
import type { Agent } from "@/generated/prisma/client";
import { withLlmProfileLimit } from "./llmProfileLimiter";

/// Grosszuegiger als der Vorgabewert des Clients: Diese Aufrufe laufen im
/// Hintergrund, niemand wartet vor dem Bildschirm – und lokale oder kostenlose
/// Modelle antworten oft erst nach Minuten.
const DEFAULT_TIMEOUT_MS = 300_000;

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

export interface RunAgentOptions {
  agent: Agent;
  projectId: string;
  /** kickoff | sprint_planning | ticket_plan | implementation | review | sprint_review | inquiry */
  kind: string;
  /** Eine Zeile fuer die Live-Ansicht: "Plant Ticket „Login-Maske"" */
  headline: string;
  system: string;
  prompt: string;
  ticketId?: string;
  sprintId?: string;
  maxTokens?: number;
  /** Zeitlimit fuer den Modellaufruf. Umsetzungsschritte brauchen deutlich
   *  laenger als eine Textantwort – ein Ticket kann mehrere Dateien umfassen. */
  timeoutMs?: number;
}

export interface AgentRunResult {
  runId: string;
  text: string;
}

/// Fuehrt einen Modellaufruf im Namen eines Agenten aus und protokolliert ihn.
/// Wirft `AgentRunError`, wenn der Aufruf scheitert – der aufrufende Task
/// entscheidet dann, ob er abbricht oder es anders versucht.
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, projectId, kind, headline, system, prompt, ticketId, sprintId } = options;

  const profile = agent.llmProfileId
    ? await prisma.llmProfile.findUnique({ where: { id: agent.llmProfileId } })
    : ((await prisma.llmProfile.findFirst({ where: { isDefault: true } })) ??
      (await prisma.llmProfile.findFirst({ orderBy: { createdAt: "asc" } })));

  const run = await prisma.agentRun.create({
    data: {
      projectId,
      agentId: agent.id,
      ticketId,
      sprintId,
      kind,
      headline,
      systemPrompt: system,
      prompt,
      llmProfileId: profile?.id ?? null,
      model: profile?.model ?? null,
    },
  });

  if (!profile) {
    await failRun(run.id, agent.id, "Dem Agenten ist kein LLM-Profil zugewiesen und es gibt kein Standardprofil.");
    throw new AgentRunError(
      `Agent „${agent.name}" hat kein LLM-Profil – unter Einstellungen → LLM-Profile eines anlegen.`,
      run.id,
    );
  }

  await prisma.agent.update({ where: { id: agent.id }, data: { status: "WORKING" } });
  const startedAt = Date.now();

  try {
    const text = await withLlmProfileLimit(profile.id, () =>
      chat({
        profile,
        system,
        prompt,
        maxTokens: options.maxTokens ?? 8000,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    );

    await prisma.$transaction([
      prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          response: text,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      }),
      prisma.agent.update({ where: { id: agent.id }, data: { status: "IDLE" } }),
    ]);

    return { runId: run.id, text };
  } catch (error) {
    const message = error instanceof LlmError || error instanceof Error ? error.message : String(error);
    await failRun(run.id, agent.id, message, Date.now() - startedAt);
    // Auch der Fehlschlag gehoert ins Protokoll im Buero, nicht nur in die
    // Nachweise: Der Mensch soll sehen, dass der Kollege haengt, ohne dafuer
    // erst die Belegliste durchzugehen.
    await logActivity({
      projectId,
      agentId: agent.id,
      ticketId,
      actor: agent.name,
      action: "step_failed",
      detail: `${headline} – abgebrochen: ${message.slice(0, 300)}`,
    });
    throw new AgentRunError(message, run.id);
  }
}

async function failRun(runId: string, agentId: string, message: string, durationMs?: number) {
  await prisma.$transaction([
    prisma.agentRun.update({
      where: { id: runId },
      data: { status: "FAILED", error: message, finishedAt: new Date(), durationMs },
    }),
    // BLOCKED statt IDLE: In der Live-Ansicht soll sofort sichtbar sein, dass
    // ein Kollege haengt – genau wie jemand, der im Buero die Hand hebt.
    prisma.agent.update({ where: { id: agentId }, data: { status: "BLOCKED" } }),
  ]);
}

/// Ein Eintrag im Projekt-Protokoll. Bewusst getrennt vom `AgentRun`: Der Run
/// ist der Beleg (Prompt/Antwort), der Log-Eintrag die Zeile, die der Mensch
/// im Buero liest ("Ben Ritter hat 3 Dateien committet").
export async function logActivity(entry: {
  projectId: string;
  actor: string;
  action: string;
  detail?: string;
  agentId?: string;
  ticketId?: string;
}) {
  await prisma.activityLogEntry.create({
    data: {
      projectId: entry.projectId,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      agentId: entry.agentId,
      ticketId: entry.ticketId,
    },
  });
}
