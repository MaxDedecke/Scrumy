// Jeder Denk-/Arbeitsschritt eines Agenten laeuft durch diese eine Funktion.
//
// Sie ist der Grund, warum das Team spaeter Rechenschaft ablegen kann: Vor dem
// Modellaufruf entsteht ein `AgentRun` mit Systemprompt, Prompt und Modell,
// danach kommen Antwort, Dauer und Status dazu – auch im Fehlerfall. Nichts,
// was ein Agent tut, passiert damit ohne Beleg. Gleichzeitig haengt hier der
// sichtbare Agentenstatus (IDLE/WORKING) und das Rate-Limit pro LLM-Profil.
import { prisma } from "@/lib/prisma";
import { chat, chatTurn, LlmError, type ChatMessage, type ReasoningEffort, type ToolCall, type ToolDef } from "@/lib/llm";
import type { Agent } from "@/generated/prisma/client";
import { withLlmProfileLimit } from "./llmProfileLimiter";

/// Grosszuegiger als der Vorgabewert des Clients: Diese Aufrufe laufen im
/// Hintergrund, niemand wartet vor dem Bildschirm – und lokale oder kostenlose
/// Modelle antworten oft erst nach Minuten.
const DEFAULT_TIMEOUT_MS = 600_000;

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly runId: string,
    // Gereicht durch von LlmError.code (siehe src/lib/llm.ts) – der Aufrufer
    // (worker/agentToolLoop.ts) muss wissen, ob der Anbieter selbst
    // gescheitert ist ("TRANSPORT"), um bisherige Dateiänderungen nicht
    // grundlos zu verwerfen.
    readonly code?: "TOKEN_LIMIT" | "TRANSPORT",
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
  /** Nur bei OpenRouter-Profilen wirksam, siehe `src/lib/llm.ts`. Reicht bis
   *  zum Anbieter durch, sonst folgenlos (z.B. bei Anthropic/Ollama). */
  reasoningEffort?: ReasoningEffort;
  preferThroughput?: boolean;
}

export interface AgentRunResult {
  runId: string;
  text: string;
}

async function resolveAgentProfile(agent: Agent) {
  return agent.llmProfileId
    ? await prisma.llmProfile.findUnique({ where: { id: agent.llmProfileId } })
    : ((await prisma.llmProfile.findFirst({ where: { isDefault: true } })) ??
      (await prisma.llmProfile.findFirst({ orderBy: { createdAt: "asc" } })));
}

/// Fuehrt einen Modellaufruf im Namen eines Agenten aus und protokolliert ihn.
/// Wirft `AgentRunError`, wenn der Aufruf scheitert – der aufrufende Task
/// entscheidet dann, ob er abbricht oder es anders versucht.
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, projectId, kind, headline, system, prompt, ticketId, sprintId } = options;

  const profile = await resolveAgentProfile(agent);

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
        reasoningEffort: options.reasoningEffort,
        preferThroughput: options.preferThroughput,
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
    throw new AgentRunError(message, run.id, error instanceof LlmError ? error.code : undefined);
  }
}

export interface RunAgentTurnOptions {
  agent: Agent;
  projectId: string;
  kind: string;
  headline: string;
  system: string;
  /** Die vollständige Konversation, wie sie an den Anbieter geht. */
  messages: ChatMessage[];
  /** Menschenlesbare Kurzfassung nur des NEUEN Teils dieses Aufrufs (z.B. die
   *  Tool-Ergebnisse, die diesen Turn ausgelöst haben) – landet in
   *  `AgentRun.prompt`. Die volle Konversation dort abzulegen würde mit jedem
   *  Turn dieselben Inhalte wiederholen, ohne neue Information zu liefern. */
  loggedPrompt: string;
  tools?: ToolDef[];
  ticketId?: string;
  sprintId?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AgentRunTurnResult {
  runId: string;
  text: string;
  toolCalls: ToolCall[];
}

/// Wie `runAgent`, aber für einen einzelnen Turn eines Tool-Loops (siehe
/// worker/agentToolLoop.ts): nimmt eine ganze Konversation statt einer
/// einzelnen Frage entgegen und gibt neben dem Text auch angeforderte
/// Werkzeugaufrufe zurück. Jeder Turn bleibt trotzdem ein eigener,
/// vollständiger `AgentRun`-Datensatz – dieselbe Rechenschaft wie bei jedem
/// anderen Agentenschritt.
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentRunTurnResult> {
  const { agent, projectId, kind, headline, system, messages, loggedPrompt, tools, ticketId, sprintId } = options;

  const profile = await resolveAgentProfile(agent);

  const run = await prisma.agentRun.create({
    data: {
      projectId,
      agentId: agent.id,
      ticketId,
      sprintId,
      kind,
      headline,
      systemPrompt: system,
      prompt: loggedPrompt,
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
    const result = await withLlmProfileLimit(profile.id, () =>
      chatTurn({
        profile,
        system,
        messages,
        tools,
        maxTokens: options.maxTokens ?? 8000,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    );

    const loggedResponse = [
      result.text,
      ...result.toolCalls.map((call) => `→ ${call.name}(${JSON.stringify(call.input)})`),
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    await prisma.$transaction([
      prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          response: loggedResponse,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      }),
      prisma.agent.update({ where: { id: agent.id }, data: { status: "IDLE" } }),
    ]);

    return { runId: run.id, text: result.text, toolCalls: result.toolCalls };
  } catch (error) {
    const message = error instanceof LlmError || error instanceof Error ? error.message : String(error);
    await failRun(run.id, agent.id, message, Date.now() - startedAt);
    await logActivity({
      projectId,
      agentId: agent.id,
      ticketId,
      actor: agent.name,
      action: "step_failed",
      detail: `${headline} – abgebrochen: ${message.slice(0, 300)}`,
    });
    throw new AgentRunError(message, run.id, error instanceof LlmError ? error.code : undefined);
  }
}

export interface TrackedToolRunOptions {
  agent: Agent;
  projectId: string;
  ticketId?: string;
  sprintId?: string;
  kind: string;
  headline: string;
  prompt: string;
}

/// Begleitet einen einzelnen, potenziell lange laufenden Werkzeugaufruf
/// (siehe LONG_RUNNING_TOOLS in worker/agentTools.ts) mit einem eigenen
/// `AgentRun`, der waehrend der Ausfuehrung `RUNNING` ist.
///
/// Ohne das existiert fuer die ganze Laufzeit eines `docker compose up`/
/// Testlaufs kein einziger laufender Run: Der Turn, der den Aufruf angefordert
/// hat, ist schon `SUCCEEDED` (das Modell hat ja schon geantwortet, bevor das
/// Werkzeug ueberhaupt startet), der naechste Turn entsteht erst, wenn das
/// Werkzeug fertig ist. Das Buero (office/page.tsx, sucht nur nach
/// `status: "RUNNING"`) zeigt den Agenten in dieser Luecke faelschlich als
/// untaetig, die Nachweisliste zeigt zuletzt "Erledigt" – obwohl der Agent
/// gerade auf einen Build/Test wartet.
export async function runTrackedTool<T extends { content: string; isError: boolean }>(
  options: TrackedToolRunOptions,
  run: () => Promise<T>,
): Promise<T> {
  const { agent, projectId, ticketId, sprintId, kind, headline, prompt } = options;

  const agentRun = await prisma.agentRun.create({
    data: { projectId, agentId: agent.id, ticketId, sprintId, kind, headline, systemPrompt: "", prompt },
  });
  await prisma.agent.update({ where: { id: agent.id }, data: { status: "WORKING" } });
  const startedAt = Date.now();

  try {
    const result = await run();
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: result.isError ? "FAILED" : "SUCCEEDED",
        response: result.content.slice(0, 20_000),
        error: result.isError ? result.content.slice(0, 2000) : null,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });
    return result;
  } catch (error) {
    // Sollte executeTool() selbst je unerwartet werfen (statt isError zurueck-
    // zugeben): den Platzhalter trotzdem abschliessen, sonst bleibt eine
    // Run-Leiche mit status RUNNING liegen, die das Buero dauerhaft als
    // "arbeitet" zeigt.
    const message = error instanceof Error ? error.message : String(error);
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: { status: "FAILED", error: message, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    throw error;
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
  supportRequestId?: string;
}) {
  await prisma.activityLogEntry.create({
    data: {
      projectId: entry.projectId,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      agentId: entry.agentId,
      ticketId: entry.ticketId,
      supportRequestId: entry.supportRequestId,
    },
  });
}
