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
    // "TRANSPORT": Anbieter/Netzwerk hat den Aufruf selbst nicht sauber
    // beantwortet (nicht erreichbar, HTTP-Fehlerstatus wie 429, kaputtes
    // JSON) – unabhängig davon, was der Agent inhaltlich vorhatte. Wer diesen
    // Code sieht, weiß: der bisherige Arbeitsstand (schon geschriebene
    // Dateien) ist nicht die Ursache und darf nicht verworfen werden (siehe
    // worker/agentToolLoop.ts).
    // "CANCELLED": Ein Mensch hat den Lauf von Hand abgebrochen (siehe
    // `signal` unten, worker/cancellation.ts) – kein Anbieterfehler und kein
    // Grund für einen weiteren Versuch in `postJson`.
    readonly code?: "TOKEN_LIMIT" | "TRANSPORT" | "CANCELLED",
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

/// Was der Anbieter über die Abrechnung dieses einen Aufrufs meldet. Nur
/// Anthropic liefert die Cache-Zahlen; bei den anderen Anbietern bleibt das
/// Feld leer (OpenAI und DeepSeek cachen serverseitig von selbst, ohne es
/// aufzuschlüsseln).
export interface TokenUsage {
  /** Tokens, die voll bezahlt wurden – ohne die beiden Cache-Posten. */
  inputTokens: number;
  outputTokens: number;
  /** Aus dem Cache gelesen (~10% des Eingabepreises). */
  cacheReadTokens: number;
  /** In den Cache geschrieben (~125% des Eingabepreises, einmalig). */
  cacheWriteTokens: number;
}

export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  /** Nur gefüllt, wenn der Anbieter Verbrauchszahlen mitschickt. */
  usage?: TokenUsage;
}

/// Nur für OpenRouter (GENERIC_OPENAI_COMPAT mit passender Base-URL) wirksam –
/// siehe Kommentar bei `chatTurnOpenAiCompat`.
export type ReasoningEffort = "low" | "medium" | "high";

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

// Diese Statuscodes sind fast immer voruebergehend (Anbieter ueberlastet,
// Gateway/Proxy hat rechtzeitig keine Antwort bekommen) – ein zweiter Versuch
// mit kurzer Pause klaert das oft von selbst, ohne dass der Aufrufer (z.B.
// worker/tasks/ticketWork.ts) das Ticket gleich als gescheitert behandeln
// muss. 524 kam konkret im Drapbox-Projekt vor: RunPods Cloudflare-Proxy hat
// die Verbindung nach seinem eigenen, festen ~100s-Fenster gekappt, lange
// bevor der eigene `timeoutMs` unten ueberhaupt greift.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 524]);

// Zwei Wiederholungen mit fester, kurzer Pause – kein Backoff-Paket, siehe
// Kommentar oben im Modul zu "ohne zusaetzliche Dependency". Mehr als zwei
// Versuche verbrennen bei einem echt ueberlasteten Anbieter nur unnoetig
// Zeit; bei einem einzelnen Ausrutscher (der beobachtete Fall) reicht einer.
const RETRY_DELAYS_MS = [2000, 5000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, headers: HeadersInit, body: unknown, timeoutMs: number, cancelSignal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: cancelSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancelSignal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Von Hand abgebrochen (siehe `cancelSignal`, worker/cancellation.ts):
      // kein Anbieter-/Netzwerkfehler, also auch kein Grund fuer einen
      // weiteren Versuch – der wuerde den Abbruch nur um RETRY_DELAYS_MS
      // verzoegern.
      if (cancelSignal?.aborted) {
        throw new LlmError("Manuell abgebrochen.", "CANCELLED");
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (!isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LlmError(`Anbieter nicht erreichbar (${url}): ${reason}`, "TRANSPORT");
    }

    const text = await response.text();
    if (!response.ok) {
      // Antwortkörper mitgeben – die Fehlermeldungen der Anbieter sind meist
      // konkret (falsches Modell, Guthaben leer, Key ungültig). "TRANSPORT",
      // weil das auch 429/5xx einschließt: rate-limitiert oder überlastet ist
      // der Anbieter, nicht der bisherige Arbeitsstand des Agenten.
      if (RETRYABLE_STATUSES.has(response.status) && !isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LlmError(`Anbieter antwortete mit ${response.status}: ${text.slice(0, 500)}`, "TRANSPORT");
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmError(`Antwort des Anbieters war kein JSON: ${text.slice(0, 300)}`, "TRANSPORT");
    }
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

/// Prompt-Caching (nur Anthropic, siehe `chatTurnAnthropic`).
///
/// Die eine Regel, aus der alles folgt: Der Cache greift ueber den PRAEFIX der
/// Anfrage, gerendert in der Reihenfolge `tools` -> `system` -> `messages`.
/// Ein einziges geaendertes Byte irgendwo im Praefix macht alles dahinter
/// ungueltig. Ein `cache_control`-Markierer sagt: "bis hierher zwischen-
/// speichern". Gelesene Tokens kosten ~10%, geschriebene einmalig ~125% des
/// Eingabepreises – bei zwei Aufrufen mit gleichem Praefix rechnet es sich
/// bereits.
///
/// Genau das ist der Zuschnitt des Werkzeug-Loops (worker/agentToolLoop.ts):
/// Bis zu 32 Turns schicken jedes Mal dieselben Werkzeugschemata, denselben
/// Systemprompt (TEAM_GRUNDREGELN, rund 4.000 Tokens) und denselben
/// Anfangsprompt (Projektkontext, Ticket, Plan, Repo-Ueberblick) erneut – und
/// obendrauf die inzwischen gewachsene Historie. Ohne Caching wird derselbe
/// Vorspann bis zu 32 Mal voll bezahlt.
///
/// Anthropic erlaubt hoechstens VIER Markierer je Anfrage. Sie werden hier so
/// verteilt:
///   1. Ende des Systemprompts – deckt `tools` + `system` mit ab, weil beide
///      davor gerendert werden. Stabil ueber alle Turns UND ueber alle
///      Aufrufe desselben Agenten hinweg.
///   2. Erste Nachricht (der Anfangsprompt) – waehrend eines Anlaufs
///      unveraendert, und der mit Abstand groesste Einzelblock. Eigener
///      Markierer, damit ein Turn auch dann noch einen Treffer landet, wenn
///      die juengeren Eintraege waehrend eines langen `run_command` aus dem
///      5-Minuten-Fenster gefallen sind.
///   3./4. Die letzten beiden Nachrichten – der mitwachsende Teil. Turn N
///      liest, was Turn N-1 geschrieben hat, und schreibt den neuen Rest
///      dazu. Zwei statt einem Markierer, damit ein einzelner abgelaufener
///      Eintrag nicht gleich die ganze Historie neu bezahlen laesst.
///
/// Ausdruecklich NICHT markiert wird ein einzelner Turn ohne Historie: Dessen
/// Praefix wiederholt sich nie, ein Markierer wuerde nur den Schreibaufschlag
/// kosten (siehe `chat`, wo nur der Systemprompt markiert wird).
const CACHE_CONTROL = { type: "ephemeral" } as const;
const MAX_CACHE_BREAKPOINTS = 4;

/// Welche Nachrichten einen Markierer bekommen (Punkte 2-4 oben). Ein
/// Markierer fuer den Systemprompt ist immer gesetzt, deshalb bleiben hier
/// hoechstens drei.
export function cacheableMessageIndices(messageCount: number): Set<number> {
  // Eine einzelne Nachricht ist der varrierende Teil einer Frage-Antwort und
  // wiederholt sich nicht – nur der Systemprompt davor lohnt.
  if (messageCount < 2) return new Set();
  const last = messageCount - 1;
  // `last - 2` statt `last - 1`: Die Historie ist user/assistant/user/…, die
  // vorletzte Nachricht gleicher Rolle ist der Stand des vorigen Turns.
  const candidates = [0, last - 2, last].filter((index) => index >= 0);
  return new Set(candidates.slice(-(MAX_CACHE_BREAKPOINTS - 1)));
}

function toAnthropicMessages(messages: ChatMessage[], cacheAt: Set<number> = new Set()) {
  return messages.map((message, index) => {
    // `cache_control` haengt immer an einem Content-BLOCK, nie an der
    // Nachricht – ein als String uebergebener Inhalt wird dafuer in seinen
    // gleichwertigen Textblock umgeschrieben.
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content } as Record<string, unknown>]
        : message.content.map((block) => {
            if (block.type === "text") return { type: "text", text: block.text } as Record<string, unknown>;
            if (block.type === "tool_use") {
              return { type: "tool_use", id: block.id, name: block.name, input: block.input } as Record<string, unknown>;
            }
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content,
              is_error: block.isError || undefined,
            } as Record<string, unknown>;
          });

    // Der Markierer gehoert an den LETZTEN Block der Nachricht: Er bedeutet
    // "Praefix bis einschliesslich hier", also muss die Nachricht vollstaendig
    // davor liegen.
    const lastBlock = blocks[blocks.length - 1];
    if (cacheAt.has(index) && lastBlock) lastBlock.cache_control = CACHE_CONTROL;

    return { role: message.role, content: blocks };
  });
}

async function chatTurnAnthropic(
  profile: ChatProfile,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  maxTokens: number,
  timeoutMs: number,
  cancelSignal?: AbortSignal,
): Promise<ChatTurnResult> {
  const base = trimTrailingSlash(profile.baseUrl || "https://api.anthropic.com");

  // Schleife nur wegen der leeren Antwort unten (siehe dortiger Kommentar) –
  // ein echter Transport-Fehler (Netzwerk, 4xx/5xx, kaputtes JSON) hat seine
  // eigene Wiederholung schon in `postJson` und wirft hier durch.
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
    const data = (await postJson(
      `${base}/v1/messages`,
      { "x-api-key": requireApiKey(profile), "anthropic-version": "2023-06-01" },
      {
        model: profile.model,
        // Bei aktuellen Modellen denkt das Modell standardmäßig mit, und
        // max_tokens deckelt Denken UND Antwort – deshalb großzügig.
        max_tokens: Math.max(maxTokens, 16000),
        // Der Systemprompt als Block statt als String, damit der Cache-Markierer
        // daran haengen kann (siehe Kommentar bei `toAnthropicMessages`). Er
        // deckt die davor gerenderten Werkzeugschemata gleich mit ab. Ein leerer
        // Textblock waere ein 400er, deshalb bei leerem Systemprompt gar keiner.
        ...(system.trim() ? { system: [{ type: "text", text: system, cache_control: CACHE_CONTROL }] } : {}),
        messages: toAnthropicMessages(messages, cacheableMessageIndices(messages.length)),
        ...(tools && tools.length > 0
          ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
          : {}),
      },
      timeoutMs,
      cancelSignal,
    )) as {
      content?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
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
      // Kein Denkfehler des Modells, sondern ein Ausrutscher des Anbieters
      // selbst (Anthropic meldet "fertig", liefert aber nichts) – erst wie
      // bei einem echten Transport-Fehler ein paar Mal an Ort und Stelle
      // erneut versuchen. Klappt das nie, den Aufrufer per "TRANSPORT" wie
      // einen Anbieter-Ausrutscher weiterarbeiten lassen (Anlauf verbuchen,
      // automatisch weiter, kein verworfener Arbeitsstand, keine
      // Eskalations-Klärung an den Menschen – siehe worker/tasks/ticketWork.ts),
      // statt ihn als Programmabsturz zu behandeln.
      if (!isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LlmError(
        `Das Modell hat keinen Text zurückgegeben${data.stop_reason ? ` (Abbruchgrund: ${data.stop_reason})` : ""}.`,
        "TRANSPORT",
      );
    }
    return {
      text,
      toolCalls,
      stopReason: data.stop_reason ?? "",
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
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
/// stattdessen als Text in `message.content` – meist weil der Server hinter
/// dem OpenAI-kompatiblen Endpunkt (z.B. vLLM ohne passenden
/// `--tool-call-parser` fürs Modell) das gar nicht erst strukturiert
/// zurückgibt. Drei beobachtete Formen, alle vom selben Modell möglich:
///   <function=NAME><parameter=PNAME>WERT</parameter></function>
///   <tool_call>{"name": "NAME", "arguments": {...}}</tool_call>   (Hermes/Qwen)
///   {"name": "NAME", "arguments": {...}}                          (ganz ohne Hülle)
/// Ohne diesen Ausweich sieht der Aufrufer "kein Werkzeugaufruf" und der
/// Umsetzungs-Loop (worker/agentToolLoop.ts) dreht sich bis zum Turn-Limit im
/// Kreis, bevor er ohne Ergebnis neu startet – deshalb hier selbst geparst.
const FUNCTION_BLOCK_RE = /<function=([a-zA-Z0-9_]+)>([\s\S]*?)<\/function>/g;
const PARAMETER_RE = /<parameter=([a-zA-Z0-9_]+)>([\s\S]*?)<\/parameter>/g;
const TOOL_CALL_TAG_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

function toolCallFromJson(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name) return null;
  const rawInput = obj.arguments ?? obj.parameters ?? {};
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return null;
  return { id: nextToolCallId(), name: obj.name, input: rawInput as Record<string, unknown> };
}

/// Sucht im Rest-Text nach freistehenden `{...}`-Objekten ohne Tags drumherum
/// und versucht sie einzeln als JSON-Werkzeugaufruf zu lesen. Klammerzählung
/// statt Regex, damit ein verschachteltes `arguments`-Objekt nicht vorzeitig
/// abgeschnitten wird. Trifft der Text zufällig ein JSON-Objekt mit `name`+
/// `arguments`, das kein Aufruf sein sollte, wird es trotzdem als einer
/// gelesen – das nimmt der bestehende `<function=>`-Fallback genauso in Kauf.
///
/// Die Zählung muss wissen, ob sie gerade in einem JSON-String steckt: Werte
/// wie `edit_file`s `search`/`replace` sind oft Quelltext-Schnipsel und
/// enthalten selbst unbalancierte `{`/`}` (z.B. ein `search`-Anker, der nur
/// aus `foo() {` besteht, ohne schließende Klammer). Zählt man diese Zeichen
/// blind mit, kommt die Tiefe nie wieder auf 0 zurück und der ganze Aufruf
/// bleibt unerkannt als Fließtext stehen – beobachtet im DemoLogin-Projekt,
/// wo genau so ein einzeiliger `search`-Anker den kompletten Tool-Aufruf zwei
/// Runden lang verschluckt hat, bis das Turn-Budget aufgebraucht war.
function extractBareJsonToolCalls(text: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      let depth = 0;
      let j = i;
      let inString = false;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (inString) {
          if (ch === "\\") {
            j++; // escapte Sequenz (\", \\, \n, \uXXXX-Start, …) – nächstes Zeichen ignorieren
            continue;
          }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      if (depth === 0) {
        try {
          const call = toolCallFromJson(JSON.parse(text.slice(i, j)));
          if (call) {
            toolCalls.push(call);
            i = j;
            continue;
          }
        } catch {
          // kein valides JSON – als normaler Text stehen lassen
        }
      }
    }
    result += text[i];
    i++;
  }
  return { text: result, toolCalls };
}

/// Vierte beobachtete Form (wieder qwen2.5-coder über den RunPod-Ollama-Proxy,
/// im OnePhoto-Projekt aufgefallen): gar keine Klammern/Tags mehr, nur der
/// Werkzeugname allein auf einer Zeile, danach abwechselnd "feld"/"wert" oder
/// "feld: wert" in einer Zeile, z.B.
///   run_command
///   command
///   npm install
///   cwd: frontend
/// Tückisch: Ohne diesen Ausweich verschwindet so ein Aufruf spurlos als
/// Fließtext, OHNE dass der Loop es merkt (worker/agentToolLoop.ts prüft nur
/// `toolCalls.length === 0` für den ganzen Turn) – der Turn enthält meist noch
/// einen echten, geklammerten Aufruf daneben, `toolCalls.length` bleibt also
/// > 0. Das Modell hält npm install/test für erledigt, bekommt aber nie ein
/// Tool-Ergebnis dazu und wiederholt dieselbe Absicht Runde für Runde, bis
/// das Turn-Budget weg ist – Ursache für ungewöhnlich lang laufende Tickets
/// ohne echten Fortschritt.
const LABELED_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
  "run_command",
  "finish",
]);
const KNOWN_FIELD_NAMES = new Set([
  "path",
  "content",
  "search",
  "replace",
  "command",
  "cwd",
  "query",
  "commitMessage",
  "summary",
  "notes",
  "clarification",
  "clarificationOptions",
]);
// Erstes Pflichtfeld der Werkzeuge mit genau einem Kernparameter – nur für
// die wird eine unbeschriftete erste Zeile als Wert übernommen. list_files
// hat keins, write_file/edit_file/finish haben mehrere Pflichtfelder, da wäre
// die Zuordnung geraten statt sicher.
const PRIMARY_FIELD: Record<string, string> = { read_file: "path", search_files: "query", run_command: "command" };

function parseLabeledToolCalls(text: string): { text: string; toolCalls: ToolCall[] } {
  const lines = text.split("\n");
  const toolCalls: ToolCall[] = [];
  const consumed = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].trim();
    if (!LABELED_TOOL_NAMES.has(name)) continue;

    const input: Record<string, unknown> = {};
    let pendingKey: string | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (!trimmed || LABELED_TOOL_NAMES.has(trimmed)) break;

      const inline = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (inline && KNOWN_FIELD_NAMES.has(inline[1])) {
        input[inline[1]] = inline[2];
        pendingKey = null;
      } else if (pendingKey) {
        input[pendingKey] = trimmed;
        pendingKey = null;
      } else if (KNOWN_FIELD_NAMES.has(trimmed)) {
        pendingKey = trimmed;
      } else if (PRIMARY_FIELD[name] && !(PRIMARY_FIELD[name] in input)) {
        input[PRIMARY_FIELD[name]] = trimmed;
      } else {
        // Weder erkanntes Feld noch (mehr) Platz für den Kernparameter –
        // gehört nicht mehr zu diesem Aufruf, Block hier beenden.
        break;
      }
    }

    // Ohne mindestens ein Feld ist "Name allein auf der Zeile" zu häufig
    // Zufallstreffer (z.B. eine Überschrift "### run_command" im Fließtext)
    // – da lieber nichts erkennen als einen leeren Aufruf erfinden.
    if (Object.keys(input).length === 0) continue;

    toolCalls.push({ id: nextToolCallId(), name, input });
    for (let k = i; k < j; k++) consumed[k] = true;
    i = j - 1;
  }

  if (toolCalls.length === 0) return { text, toolCalls: [] };
  return { text: lines.filter((_, idx) => !consumed[idx]).join("\n").trim(), toolCalls };
}

// exportiert nur für den Regressionstest (tests/llmPseudoToolCalls.test.ts)
export function parsePseudoToolCalls(text: string): { text: string; toolCalls: ToolCall[] } {
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

  for (const match of cleaned.matchAll(TOOL_CALL_TAG_RE)) {
    try {
      const call = toolCallFromJson(JSON.parse(match[1].trim()));
      if (call) {
        toolCalls.push(call);
        cleaned = cleaned.replace(match[0], "");
      }
    } catch {
      // kaputtes JSON im Tag – als Text stehen lassen statt zu crashen
    }
  }

  const bare = extractBareJsonToolCalls(cleaned);
  toolCalls.push(...bare.toolCalls);
  cleaned = bare.text;

  const labeled = parseLabeledToolCalls(cleaned);
  toolCalls.push(...labeled.toolCalls);
  cleaned = labeled.text;

  // Umschließende Reste (<tool_call>, </tool_call>) weg – was übrig bleibt,
  // ist der echte Fließtext-Anteil der Antwort.
  cleaned = cleaned.replace(/<\/?tool_call>/g, "").trim();
  return { text: cleaned, toolCalls };
}

/// Ergänzt vom Server bereits strukturiert gelieferte `tool_calls` um weitere
/// Aufrufe, die das Modell zusätzlich nur als Klartext-JSON in `content`
/// mitgeschickt hat – statt `parsePseudoToolCalls` nur dann laufen zu lassen,
/// wenn der Server GAR KEINE strukturierten Aufrufe lieferte.
///
/// Konkreter Vorfall (Drapbox-Projekt, 20.08.2026): Der RunPod-Ollama-Server
/// gab neben zwei echten `run_command`-Aufrufen einen erfundenen dritten
/// strukturiert zurück (Name aus einer verschachtelten JSON-Zeichenkette im
/// content gegriffen, ohne Argumente). Weil `toolCalls.length` dadurch schon
/// > 0 war, blieb der Fallback bisher komplett aus – drei echte
/// `write_file`-Aufrufe, die das Modell im selben `content` als sauberes
/// JSON aufgeschrieben hatte (package.json, authModel.ts, authService.ts),
/// wurden nie erkannt und nie ausgeführt. Das Ticket drehte sich dadurch
/// Anlauf für Anlauf im Kreis: "package.json fehlt" -> Plan, sie zu
/// erstellen -> Antwort mit dem Schreibaufruf im Text -> nie ausgeführt ->
/// "package.json fehlt" von vorn.
///
/// Nimmt in Kauf, dass ein Aufruf doppelt ausgeführt wird, falls ein Server
/// ihn sowohl strukturiert als auch als Text zurückgibt (bei `write_file`
/// harmlos, bei `run_command` bestenfalls Zeitverschwendung) – seltener und
/// billiger als der beobachtete Totalverlust echter Aufrufe.
function mergeWithPseudoToolCalls(text: string, toolCalls: ToolCall[]): { text: string; toolCalls: ToolCall[] } {
  if (!text.trim()) return { text, toolCalls };
  const fallback = parsePseudoToolCalls(text);
  if (fallback.toolCalls.length === 0) return { text, toolCalls };
  return { text: fallback.text, toolCalls: [...toolCalls, ...fallback.toolCalls] };
}

async function chatTurnOllama(
  profile: ChatProfile,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[] | undefined,
  timeoutMs: number,
  cancelSignal?: AbortSignal,
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
    cancelSignal,
  )) as { message?: { content?: string; tool_calls?: OpenAiToolCall[] } };

  let text = pickString(data.message?.content) ?? "";
  let toolCalls = parseOpenAiToolCalls(data.message?.tool_calls);
  ({ text, toolCalls } = mergeWithPseudoToolCalls(text, toolCalls));
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
  reasoningEffort?: ReasoningEffort,
  preferThroughput?: boolean,
  cancelSignal?: AbortSignal,
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

  // `reasoning`/`provider` sind OpenRouter-eigene Erweiterungen des
  // OpenAI-Vertrags – ein anderer OpenAI-kompatibler Anbieter hinter
  // GENERIC_OPENAI_COMPAT kennt sie nicht zwangsläufig, deshalb nur schicken,
  // wenn die Base-URL wirklich auf OpenRouter zeigt.
  const isOpenRouter = base.includes("openrouter.ai");
  const openRouterExtras = {
    ...(isOpenRouter && reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    // "sort: throughput" statt eines fest einprogrammierten Provider-Namens:
    // OpenRouter routet `deepseek-v4-flash-0731` über 30 Upstream-Anbieter mit
    // stark schwankender Geschwindigkeit (im Knowledge-Hub-Projekt beobachtet:
    // 8 Tokens/s bei einem als "degradiert" markierten Anbieter vs. über 100
    // Tokens/s bei anderen) – eine feste Liste würde veralten, sobald sich die
    // Anbieter-Gesundheit ändert.
    ...(isOpenRouter && preferThroughput ? { provider: { sort: "throughput" } } : {}),
  };

  type OpenAiCompatData = {
    choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
    error?: { message?: string };
    // Anders als bei Anthropic gibt es hier nichts zu markieren: OpenAI und
    // DeepSeek (auch ueber OpenRouter) speichern lange Praefixe von selbst
    // zwischen, ohne Zutun des Aufrufers. Was fehlt, ist die Sicht darauf –
    // deshalb wenigstens die Zahlen mitnehmen, damit sich beantworten laesst,
    // ob es im laufenden Betrieb tatsaechlich greift.
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  // Wie bei Anthropic (siehe dortiger Kommentar): Reasoning-Modelle wie
  // deepseek-v4-flash denken auch über den OpenAI-kompatiblen Endpunkt in
  // dasselbe Budget hinein, das `max_tokens` setzt – ein knapper Aufrufer-Wert
  // (z.B. 300 für einen kurzen JSON-Check) lässt dann die Antwort selbst mitten
  // im JSON abreißen. Beobachtet im Drapbox-Projekt: `checkAlreadySatisfied`
  // schlug deshalb reihenweise mit TOKEN_LIMIT fehl, bis die Klärung offen
  // liegen blieb und das ganze Team stillstand.
  const effectiveMaxTokens = Math.max(maxTokens, 16000);

  // Schleife nur wegen der leeren Antwort unten (siehe dortiger Kommentar) –
  // ein echter Transport-Fehler (Netzwerk, 4xx/5xx, kaputtes JSON) hat seine
  // eigene Wiederholung schon in `postJson` und wirft hier durch.
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
    let data: OpenAiCompatData;
    try {
      data = (await postJson(
        url,
        headers,
        {
          model: profile.model,
          max_tokens: effectiveMaxTokens,
          messages: openAiMessages,
          ...(openAiTools ? { tools: openAiTools } : {}),
          ...openRouterExtras,
        },
        timeoutMs,
        cancelSignal,
      )) as OpenAiCompatData;
    } catch (error) {
      // Neuere Modelle (u.a. die o1-/gpt-5-Reihe) lehnen `max_tokens` ab und
      // verlangen `max_completion_tokens` – einmalig mit dem anderen
      // Feldnamen erneut versuchen, statt den Nutzer mit dem Rohfehler
      // allein zu lassen.
      if (error instanceof LlmError && error.message.includes("max_completion_tokens")) {
        data = (await postJson(
          url,
          headers,
          {
            model: profile.model,
            max_completion_tokens: effectiveMaxTokens,
            messages: openAiMessages,
            ...(openAiTools ? { tools: openAiTools } : {}),
            ...openRouterExtras,
          },
          timeoutMs,
          cancelSignal,
        )) as OpenAiCompatData;
      } else {
        throw error;
      }
    }

    if (data.error?.message) throw new LlmError(data.error.message);

    const choice = data.choices?.[0];
    let text = pickString(choice?.message?.content) ?? "";
    let toolCalls = parseOpenAiToolCalls(choice?.message?.tool_calls);
    // Server hinter dem OpenAI-kompatiblen Endpunkt liefert Tool-Aufrufe
    // manchmal nicht (vollständig) strukturiert (siehe Kommentar bei
    // `mergeWithPseudoToolCalls`) – häufig bei lokalen/selbstgehosteten
    // Modellen wie Qwen ohne passenden Tool-Call-Parser auf dem Server. Läuft
    // bewusst auch dann noch, wenn schon strukturierte Aufrufe da sind: Ein
    // Server kann einen echten Aufruf strukturiert und einen zweiten nur als
    // Text im selben content liefern.
    ({ text, toolCalls } = mergeWithPseudoToolCalls(text, toolCalls));

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
      // (`finish_reason: "length"`). Kein Denkfehler des Modells, sondern ein
      // Ausrutscher des Anbieters selbst (beobachtet u.a. bei OpenRouter,
      // dessen Multi-Upstream-Routing auch sonst schon fuer schwankende
      // Antwortqualitaet sorgt) – erst wie bei einem echten Transport-Fehler
      // ein paar Mal an Ort und Stelle erneut versuchen. Klappt das nie, den
      // Aufrufer per "TRANSPORT" wie einen Anbieter-Ausrutscher weiterarbeiten
      // lassen (Anlauf verbuchen, automatisch weiter, kein verworfener
      // Arbeitsstand, keine Eskalations-Klärung an den Menschen – siehe
      // worker/tasks/ticketWork.ts), statt ihn als Programmabsturz zu
      // behandeln.
      const reason = choice?.finish_reason;
      if (!isLastAttempt) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new LlmError(
        `Der Anbieter hat keinen Text zurückgegeben${reason ? ` (Abbruchgrund: ${reason})` : ""}.`,
        "TRANSPORT",
      );
    }
    // `prompt_tokens` enthaelt hier – anders als Anthropics `input_tokens` – die
    // aus dem Cache bedienten Tokens bereits mit. Fuer eine ueber alle Anbieter
    // gleich lesbare Zahl wird der Cache-Anteil deshalb herausgerechnet.
    const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      toolCalls,
      stopReason: choice?.finish_reason ?? "",
      ...(data.usage
        ? {
            usage: {
              inputTokens: Math.max((data.usage.prompt_tokens ?? 0) - cachedTokens, 0),
              outputTokens: data.usage.completion_tokens ?? 0,
              cacheReadTokens: cachedTokens,
              // Diese Anbieter weisen keinen Schreibposten aus – sie berechnen
              // fuer das Anlegen eines Eintrags keinen Aufschlag.
              cacheWriteTokens: 0,
            },
          }
        : {}),
    };
  }
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
  reasoningEffort,
  preferThroughput,
  signal,
}: {
  profile: ChatProfile;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Nur bei OpenRouter (GENERIC_OPENAI_COMPAT) wirksam: begrenzt, wie viele
   *  Tokens ein Reasoning-Modell fürs Nachdenken verbrennen darf, bevor es
   *  antwortet – ohne das kann sich ein Modell wie deepseek-v4-flash im
   *  Nachdenken verlieren und nie eine Antwort liefern (siehe Kommentar bei
   *  `chatTurnOpenAiCompat`). */
  reasoningEffort?: ReasoningEffort;
  /** Nur bei OpenRouter wirksam: bevorzugt den Upstream-Anbieter mit dem
   *  höchsten gemessenen Durchsatz statt OpenRouters Standardrouting, das
   *  auch spürbar langsamere/instabile Anbieter treffen kann. */
  preferThroughput?: boolean;
  /** Von Hand ausgelöster Abbruch (siehe worker/cancellation.ts) – bricht den
   *  laufenden HTTP-Aufruf sofort ab, statt auf `timeoutMs` zu warten. */
  signal?: AbortSignal;
}): Promise<ChatTurnResult> {
  const result = await (() => {
    switch (profile.provider) {
      case "ANTHROPIC":
        return chatTurnAnthropic(profile, system, messages, tools, maxTokens, timeoutMs, signal);
      case "OLLAMA":
        return chatTurnOllama(profile, system, messages, tools, timeoutMs, signal);
      case "OPENAI":
      case "GENERIC_OPENAI_COMPAT":
        return chatTurnOpenAiCompat(profile, system, messages, tools, maxTokens, timeoutMs, reasoningEffort, preferThroughput, signal);
    }
  })();

  logTokenUsage(profile.model, result.usage);
  return result;
}

/// Die einzige Stelle, an der sich nachsehen laesst, ob das Prompt-Caching
/// wirklich greift – ohne sie ist der Unterschied zwischen "funktioniert" und
/// "schreibt jedes Mal einen neuen Eintrag" auf der Rechnung nicht zu
/// erkennen. Bleibt `cache_read` ueber mehrere Turns hinweg 0, hat etwas den
/// Praefix veraendert (ein Zeitstempel im Systemprompt, eine andere
/// Werkzeugreihenfolge, ein gewechseltes Modell).
function logTokenUsage(model: string, usage?: TokenUsage): void {
  if (!usage) return;
  console.log(
    `[llm] ${model} tokens: in=${usage.inputTokens} out=${usage.outputTokens} ` +
      `cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens}`,
  );
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
  reasoningEffort,
  preferThroughput,
  signal,
}: {
  profile: ChatProfile;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  preferThroughput?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await chatTurn({
    profile,
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens,
    timeoutMs,
    reasoningEffort,
    preferThroughput,
    signal,
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
