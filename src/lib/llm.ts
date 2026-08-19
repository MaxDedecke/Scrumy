import type { LlmProfile, LlmProvider } from "@/generated/prisma/client";

// Minimaler Chat-Client für alle vier Anbieter aus `LlmProfile`.
//
// Bewusst per fetch und ohne Anbieter-SDK: Das Datenmodell erlaubt pro Agent
// ein beliebiges Profil (Cloud oder lokaler Container), und ein SDK je Anbieter
// hieße vier Codepfade mit vier Fehlerbildern. Genau wie bei den Icons und dem
// Rate-Limiter bleibt es hier bei einer handgeschriebenen, schmalen Lösung
// ohne zusätzliche Dependency.
//
// Tool-Calling (siehe `chatTurn`/`ChatMessage`/`ToolDef`): Anthropic hat eine
// eigene Content-Block-Verdrahtung, OPENAI/GENERIC_OPENAI_COMPAT/OLLAMA
// sprechen alle drei denselben `tools`/`tool_calls`/`role:"tool"`-Vertrag
// (Ollama seit den Modellen mit Funktionsunterstützung) – deshalb zwei Drähte
// statt vier, nicht eins pro Anbieter.

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code?: "TOKEN_LIMIT",
  ) {
    super(message);
    this.name = "LlmError";
  }
}

type ChatProfile = Pick<LlmProfile, "name" | "provider" | "model" | "baseUrl" | "apiKeyRef">;

/// Ein Werkzeugbaustein einer Modellantwort. `text` ist normaler Fließtext,
/// `tool_use` ein Aufruf, den der Aufrufer ausführen und dessen Ergebnis er
/// als `tool_result` in der nächsten Nutzernachricht zurückgeben muss – exakt
/// wie bei Anthropics Content-Block-API, auf die die anderen drei Anbieter
/// unten abgebildet werden.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON-Schema-Objekt (type: "object", properties: {...}, required: [...]). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
}

const PROVIDER_ENV_VAR: Record<LlmProvider, string | null> = {
  ANTHROPIC: "ANTHROPIC_API_KEY",
  OPENAI: "OPENAI_API_KEY",
  GENERIC_OPENAI_COMPAT: "LLM_API_KEY",
  OLLAMA: null, // lokal, kein Schlüssel
};

/// Löst den Schlüssel zum Profil auf.
///
/// Reihenfolge: `env:NAME` (empfohlen – der Schlüssel bleibt außerhalb der DB)
/// -> Schlüssel steht direkt im Feld (funktioniert, ist aber unverschlüsselt in
/// der Datenbank) -> anbieterspezifische Umgebungsvariable.
function resolveApiKey(profile: ChatProfile): string | null {
  const ref = profile.apiKeyRef?.trim();

  if (ref?.startsWith("env:")) {
    const name = ref.slice("env:".length).trim();
    const value = process.env[name]?.trim();
    if (!value) {
      throw new LlmError(
        `Profil „${profile.name}" verweist auf die Umgebungsvariable ${name}, die nicht gesetzt ist.`,
      );
    }
    return value;
  }

  // vault://… o.ä. kann diese App (noch) nicht auflösen – klar sagen statt
  // die Referenz als Schlüssel an den Anbieter zu schicken.
  if (ref?.includes("://")) {
    throw new LlmError(
      `Profil „${profile.name}" nutzt die Referenz „${ref}". Auflösung von Secret-Referenzen ist nicht implementiert – stattdessen „env:NAME" verwenden.`,
    );
  }

  if (ref) return ref;

  const envVar = PROVIDER_ENV_VAR[profile.provider];
  const fromEnv = envVar ? process.env[envVar]?.trim() : undefined;
  return fromEnv || null;
}

function requireApiKey(profile: ChatProfile): string {
  const key = resolveApiKey(profile);
  if (!key) {
    const envVar = PROVIDER_ENV_VAR[profile.provider];
    throw new LlmError(
      `Für Profil „${profile.name}" ist kein API-Key hinterlegt (Feld „API-Key-Referenz" oder Umgebungsvariable ${envVar}).`,
    );
  }
  return key;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function postJson(url: string, headers: HeadersInit, body: unknown, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmError(`Anbieter nicht erreichbar (${url}): ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    // Antwortkörper mitgeben – die Fehlermeldungen der Anbieter sind meist
    // konkret (falsches Modell, Guthaben leer, Key ungültig).
    throw new LlmError(`Anbieter antwortete mit ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError(`Antwort des Anbieters war kein JSON: ${text.slice(0, 300)}`);
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

let toolCallCounter = 0;
/// Eindeutige Id für einen Tool-Aufruf, dessen Anbieter selbst keine liefert
/// (Ollama). Anthropic/OpenAI-kompatible Anbieter liefern eigene Ids, die
/// unten Vorrang haben.
function nextToolCallId(): string {
  toolCallCounter += 1;
  return `call_${Date.now().toString(36)}_${toolCallCounter}`;
}

// --- Anthropic --------------------------------------------------------------

function toAnthropicMessages(messages: ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => {
            if (block.type === "text") return { type: "text", text: block.text };
            if (block.type === "tool_use") {
              return { type: "tool_use", id: block.id, name: block.name, input: block.input };
            }
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content,
              is_error: block.isError || undefined,
            };
          }),
  }));
}

async function chatTurnAnthropic(
  profile: ChatProfile,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  maxTokens: number,
  timeoutMs: number,
): Promise<ChatTurnResult> {
  const base = trimTrailingSlash(profile.baseUrl || "https://api.anthropic.com");
  const data = (await postJson(
    `${base}/v1/messages`,
    { "x-api-key": requireApiKey(profile), "anthropic-version": "2023-06-01" },
    {
      model: profile.model,
      // Bei aktuellen Modellen denkt das Modell standardmäßig mit, und
      // max_tokens deckelt Denken UND Antwort – deshalb großzügig.
      max_tokens: Math.max(maxTokens, 16000),
      system,
      messages: toAnthropicMessages(messages),
      ...(tools && tools.length > 0
        ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
        : {}),
    },
    timeoutMs,
  )) as {
    content?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
    stop_reason?: string;
  };

  if (data.stop_reason === "refusal") {
    throw new LlmError("Das Modell hat die Anfrage abgelehnt.");
  }

  const blocks = data.content ?? [];
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: block.id ?? nextToolCallId(), name: block.name ?? "", input: block.input ?? {} }));

  if (data.stop_reason === "max_tokens") {
    throw new LlmError(
      "Die Modellantwort wurde am Token-Limit abgeschnitten. Das Ergebnis wird aus Sicherheitsgründen nicht angewendet.",
      "TOKEN_LIMIT",
    );
  }
  // Nur ohne Werkzeuge muss Text da sein – ein reiner Tool-Aufruf ohne
  // Begleittext ist eine ganz normale, gültige Antwort.
  if (!text.trim() && toolCalls.length === 0) {
    throw new LlmError(
      `Das Modell hat keinen Text zurückgegeben${data.stop_reason ? ` (Abbruchgrund: ${data.stop_reason})` : ""}.`,
    );
  }
  return { text, toolCalls, stopReason: data.stop_reason ?? "" };
}

// --- OpenAI und OpenAI-kompatibel (OpenAI, GENERIC_OPENAI_COMPAT, Ollama) --

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

/// Unsere normalisierten Nachrichten auf den OpenAI-Vertrag abgebildet: ein
/// `tool_use`-Block wird zu `tool_calls` auf einer Assistant-Nachricht, ein
/// `tool_result`-Block zu einer eigenen Nachricht mit `role: "tool"`.
/// `argumentsAsObject`: Die echte OpenAI-API verlangt `tool_calls[].function.arguments`
/// als JSON-**String** – das ist der Default hier (für OPENAI/GENERIC_OPENAI_COMPAT).
/// Ollamas eigenes, nicht standardkonformes `/api/chat` will dagegen ein rohes
/// **Objekt**: Kommt ein String rein, versucht Ollamas Parser ihn beim Aufbau des
/// Prompts trotzdem wie ein Objekt zu lesen und stolpert über escapte
/// Anführungszeichen/Klammern im Inhalt ("Value looks like object, but can't find
/// closing '}' symbol") – reproduziert direkt gegen den Runpod-Endpunkt. Betraf nur
/// den neuen Mehrschritt-Tool-Loop (`agentToolLoop.ts`), weil erst der einen
/// vorigen Tool-Aufruf in der Historie zurückschickt.
function toOpenAiMessages(system: string, messages: ChatMessage[], argumentsAsObject = false) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const textParts = message.content.filter((block) => block.type === "text").map((block) => block.text);
    const toolUses = message.content.filter((block) => block.type === "tool_use");
    const toolResults = message.content.filter((block) => block.type === "tool_result");

    if (toolUses.length > 0) {
      out.push({
        role: "assistant",
        content: textParts.join("") || null,
        tool_calls: toolUses.map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: argumentsAsObject ? block.input : JSON.stringify(block.input) },
        })),
      });
    } else if (textParts.length > 0) {
      out.push({ role: message.role, content: textParts.join("") });
    }

    for (const result of toolResults) {
      out.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
    }
  }

  return out;
}

function parseOpenAiToolCalls(raw: OpenAiToolCall[] | undefined): ToolCall[] {
  if (!raw) return [];
  return raw.map((call) => {
    const rawArgs = call.function?.arguments;
    let input: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      try {
        input = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        // Ein Modell, das kein gültiges JSON für die Argumente liefert, macht
        // den Aufruf nicht ungültig – er kommt leer an, und der Ausführer
        // (worker/agentTools.ts) meldet den fehlenden Pflichtparameter als
        // normales Tool-Ergebnis zurück, das Modell kann im selben Loop
        // korrigieren.
        input = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      input = rawArgs;
    }
    return { id: call.id ?? nextToolCallId(), name: call.function?.name ?? "", input };
  });
}

/// Manche Modelle (beobachtet bei qwen3-coder über Ollamas eigenen
/// "qwen3-coder"-Renderer/Parser, siehe RunPod-Setup) rutschen gelegentlich
/// aus dem strukturierten `tool_calls`-Feld raus und schreiben den Aufruf
/// stattdessen als Text in `message.content` – meist fehlt der öffnende
/// `<tool_call>`-Tag, weshalb Ollamas Parser den Block nicht erkennt:
///   <function=NAME>
///   <parameter=PNAME>
///   WERT
///   </parameter>
///   </function>
///   </tool_call>
/// Ohne diesen Ausweich sieht der Aufrufer "kein Werkzeugaufruf" und der
/// Umsetzungs-Loop (worker/agentToolLoop.ts) dreht sich bis zum Turn-Limit im
/// Kreis, bevor er ohne Ergebnis neu startet – deshalb hier selbst geparst.
const FUNCTION_BLOCK_RE = /<function=([a-zA-Z0-9_]+)>([\s\S]*?)<\/function>/g;
const PARAMETER_RE = /<parameter=([a-zA-Z0-9_]+)>([\s\S]*?)<\/parameter>/g;

function parsePseudoToolCalls(text: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let cleaned = text;
  for (const match of text.matchAll(FUNCTION_BLOCK_RE)) {
    const input: Record<string, unknown> = {};
    for (const paramMatch of match[2].matchAll(PARAMETER_RE)) {
      input[paramMatch[1]] = paramMatch[2].trim();
    }
    toolCalls.push({ id: nextToolCallId(), name: match[1], input });
    cleaned = cleaned.replace(match[0], "");
  }
  // Umschließende Reste (<tool_call>, </tool_call>) weg – was übrig bleibt,
  // ist der echte Fließtext-Anteil der Antwort.
  cleaned = cleaned.replace(/<\/?tool_call>/g, "").trim();
  return { text: cleaned, toolCalls };
}

async function chatTurnOllama(
  profile: ChatProfile,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  timeoutMs: number,
): Promise<ChatTurnResult> {
  const base = trimTrailingSlash(profile.baseUrl || "http://ollama:11434");
  const data = (await postJson(
    `${base}/api/chat`,
    {},
    {
      model: profile.model,
      stream: false,
      messages: toOpenAiMessages(system, messages, true),
      ...(tools && tools.length > 0
        ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }
        : {}),
    },
    timeoutMs,
  )) as { message?: { content?: string; tool_calls?: OpenAiToolCall[] } };

  let text = pickString(data.message?.content) ?? "";
  let toolCalls = parseOpenAiToolCalls(data.message?.tool_calls);
  if (toolCalls.length === 0 && text.includes("<function=")) {
    const fallback = parsePseudoToolCalls(text);
    if (fallback.toolCalls.length > 0) {
      toolCalls = fallback.toolCalls;
      text = fallback.text;
    }
  }
  if (!text.trim() && toolCalls.length === 0) {
    throw new LlmError("Ollama hat keinen Text zurückgegeben.");
  }
  return { text, toolCalls, stopReason: toolCalls.length > 0 ? "tool_use" : "stop" };
}

async function chatTurnOpenAiCompat(
  profile: ChatProfile,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  maxTokens: number,
  timeoutMs: number,
): Promise<ChatTurnResult> {
  const fallback = profile.provider === "OPENAI" ? "https://api.openai.com/v1" : null;
  const base = trimTrailingSlash(profile.baseUrl || fallback || "");
  if (!base) {
    throw new LlmError(`Profil „${profile.name}" braucht eine Base-URL (z.B. https://openrouter.ai/api/v1).`);
  }

  const headers = { authorization: `Bearer ${requireApiKey(profile)}` };
  const openAiMessages = toOpenAiMessages(system, messages);
  const openAiTools =
    tools && tools.length > 0
      ? tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
      : undefined;
  const url = `${base}/chat/completions`;

  let data: {
    choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
    error?: { message?: string };
  };
  try {
    data = (await postJson(
      url,
      headers,
      { model: profile.model, max_tokens: maxTokens, messages: openAiMessages, ...(openAiTools ? { tools: openAiTools } : {}) },
      timeoutMs,
    )) as typeof data;
  } catch (error) {
    // Neuere Modelle (u.a. die o1-/gpt-5-Reihe) lehnen `max_tokens` ab und
    // verlangen `max_completion_tokens` – einmalig mit dem anderen
    // Feldnamen erneut versuchen, statt den Nutzer mit dem Rohfehler
    // allein zu lassen.
    if (error instanceof LlmError && error.message.includes("max_completion_tokens")) {
      data = (await postJson(
        url,
        headers,
        { model: profile.model, max_completion_tokens: maxTokens, messages: openAiMessages, ...(openAiTools ? { tools: openAiTools } : {}) },
        timeoutMs,
      )) as typeof data;
    } else {
      throw error;
    }
  }

  if (data.error?.message) throw new LlmError(data.error.message);

  const choice = data.choices?.[0];
  const text = pickString(choice?.message?.content) ?? "";
  const toolCalls = parseOpenAiToolCalls(choice?.message?.tool_calls);

  if (choice?.finish_reason === "length") {
    throw new LlmError(
      "Die Modellantwort wurde am Token-Limit abgeschnitten. Das Ergebnis wird aus Sicherheitsgründen nicht angewendet.",
      "TOKEN_LIMIT",
    );
  }
  if (!text && toolCalls.length === 0) {
    // Leere Antwort ohne Grund ist für den Nutzer nicht zu deuten. Der
    // häufigste Fall bei Reasoning-Modellen: Das Token-Budget ging beim
    // Nachdenken drauf, für die Antwort blieb nichts übrig
    // (`finish_reason: "length"`).
    const reason = choice?.finish_reason;
    throw new LlmError(
      `Der Anbieter hat keinen Text zurückgegeben${reason ? ` (Abbruchgrund: ${reason})` : ""}.`,
    );
  }
  return { text, toolCalls, stopReason: choice?.finish_reason ?? "" };
}

/// Ein Frage-Antwort-Aufruf gegen das Profil, mit optionalen Werkzeugen und
/// mehreren Nachrichten (Konversation statt einer einzelnen Frage) – das
/// Fundament für den Agenten-Tool-Loop in `worker/agentToolLoop.ts`. Kein
/// Streaming: Läuft im Hintergrund (Server-Actions/Worker-Jobs), niemand
/// wartet live auf Teilantworten.
export async function chatTurn({
  profile,
  system,
  messages,
  tools,
  maxTokens = 8000,
  timeoutMs = 180_000,
}: {
  profile: ChatProfile;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<ChatTurnResult> {
  switch (profile.provider) {
    case "ANTHROPIC":
      return chatTurnAnthropic(profile, system, messages, tools, maxTokens, timeoutMs);
    case "OLLAMA":
      return chatTurnOllama(profile, system, messages, tools, timeoutMs);
    case "OPENAI":
    case "GENERIC_OPENAI_COMPAT":
      return chatTurnOpenAiCompat(profile, system, messages, tools, maxTokens, timeoutMs);
  }
}

/// Einfacher Frage-Antwort-Aufruf ohne Werkzeuge – dünner Wrapper um
/// `chatTurn` für alle Aufrufer, die nur Text wollen (Planung, Review,
/// Sprint-Planung, Kickoff, …). Bleibt aus Kompatibilitätsgründen bestehen,
/// damit diese Aufrufer unverändert bleiben.
export async function chat({
  profile,
  system,
  prompt,
  maxTokens = 8000,
  timeoutMs = 180_000,
}: {
  profile: ChatProfile;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string> {
  const result = await chatTurn({
    profile,
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens,
    timeoutMs,
  });
  return result.text;
}

/// Holt das erste JSON-Objekt aus einer Modellantwort – gleiche Toleranz wie
/// `extractJsonArray`, nur für Antworten, die genau ein Objekt liefern sollen
/// (z.B. Sprint-Planung: Ziel + Ticketliste in einem Ergebnis).
export function extractJsonObject(text: string): Record<string, unknown> {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new LlmError(`Antwort enthielt kein JSON-Objekt: ${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    throw new LlmError(`JSON-Objekt war nicht lesbar: ${withoutFences.slice(start, start + 300)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LlmError("Antwort war kein Objekt.");
  }
  return parsed as Record<string, unknown>;
}

/// Holt das erste JSON-Array aus einer Modellantwort. Modelle rahmen JSON gern
/// in ```json-Blöcke oder schreiben einen Satz davor – beides wird toleriert,
/// statt sich auf perfekte Formatbefolgung zu verlassen.
export function extractJsonArray(text: string): unknown[] {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new LlmError(`Antwort enthielt keine JSON-Liste: ${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    throw new LlmError(`JSON-Liste war nicht lesbar: ${withoutFences.slice(start, start + 300)}`);
  }

  if (!Array.isArray(parsed)) throw new LlmError("Antwort war keine Liste.");
  return parsed;
}
