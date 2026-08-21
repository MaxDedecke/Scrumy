import assert from "node:assert/strict";
import test from "node:test";
import { chat, chatTurn, type ChatMessage } from "../src/lib/llm";

// Prompt-Caching im Anthropic-Pfad (siehe src/lib/llm.ts). Der Werkzeug-Loop
// (worker/agentToolLoop.ts) schickt bis zu 32 Mal denselben Vorspann –
// Werkzeugschemata, TEAM_GRUNDREGELN (rund 4.000 Tokens) und den
// Anfangsprompt mit Projektkontext, Ticket und Plan. Ohne Markierer wird der
// jedes Mal voll bezahlt.
//
// Getestet wird das, was am ehesten unbemerkt kaputtgeht: dass die Markierer
// ueberhaupt gesetzt werden, dass ihre Zahl das Anbieter-Limit von VIER nie
// reisst (sonst antwortet Anthropic mit 400 und der ganze Agentenschritt
// scheitert), und dass ein einzelner Frage-Antwort-Aufruf ohne wiederkehrenden
// Praefix keinen Schreibaufschlag zahlt.

const ANTHROPIC_PROFILE = {
  name: "Test-Profil",
  provider: "ANTHROPIC" as const,
  model: "claude-opus-5",
  baseUrl: null,
  apiKeyRef: "test-key",
};

/// Faengt den Anfragekoerper ab, den `chatTurn` an den Anbieter schickt.
async function captureRequest(run: () => Promise<unknown>): Promise<Record<string, any>> {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, any> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

/// Zaehlt alle `cache_control`-Markierer der Anfrage – ueber System- und
/// Nachrichtenbloecke hinweg, denn das Limit von vier gilt fuer die gesamte
/// Anfrage, nicht je Abschnitt.
function countBreakpoints(body: Record<string, any>): number {
  const systemBlocks = Array.isArray(body.system) ? body.system : [];
  const messageBlocks = (body.messages ?? []).flatMap((message: any) =>
    Array.isArray(message.content) ? message.content : [],
  );
  return [...systemBlocks, ...messageBlocks].filter((block: any) => block?.cache_control).length;
}

/// Baut eine Historie, wie sie im Werkzeug-Loop entsteht: Anfangsprompt,
/// danach je Turn eine Modellantwort und ein Werkzeugergebnis.
function loopHistory(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "Anfangsprompt mit Ticket und Plan" }];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `call_${turn}`, name: "read_file", input: { path: "src/a.ts" } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", toolUseId: `call_${turn}`, content: "Dateiinhalt" }],
    });
  }
  return messages;
}

test("der Systemprompt wird zwischengespeichert und deckt die Werkzeugschemata mit ab", async () => {
  const body = await captureRequest(() =>
    chatTurn({
      profile: ANTHROPIC_PROFILE,
      system: "TEAM_GRUNDREGELN …",
      messages: loopHistory(3),
      tools: [{ name: "read_file", description: "liest", inputSchema: { type: "object", properties: {} } }],
    }),
  );

  assert.ok(Array.isArray(body.system), "erwartet: Systemprompt als Blockliste, sonst traegt er keinen Markierer");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  // Die Reihenfolge tools -> system -> messages ist der Grund, warum EIN
  // Markierer am Systemprompt beides abdeckt: Werkzeuge liegen davor.
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
});

test("der Anfangsprompt und der mitwachsende Teil bekommen eigene Markierer", async () => {
  const body = await captureRequest(() =>
    chatTurn({ profile: ANTHROPIC_PROFILE, system: "TEAM_GRUNDREGELN …", messages: loopHistory(3) }),
  );

  const marked = body.messages
    .map((message: any, index: number) =>
      (Array.isArray(message.content) ? message.content : []).some((block: any) => block?.cache_control) ? index : -1,
    )
    .filter((index: number) => index >= 0);

  const last = body.messages.length - 1;
  assert.deepEqual(
    marked,
    [0, last - 2, last],
    "erwartet: Anfangsprompt, voriger Turn und aktueller Stand – der vorige Turn haelt den Treffer, wenn der juengste Eintrag abgelaufen ist",
  );
});

test("das Limit von vier Markierern wird auch bei langer Historie nie gerissen", async () => {
  // 50 Turns ist die Obergrenze aus worker/agentToolLoop.ts (MAX_TOOL_TURNS).
  for (const turns of [0, 1, 2, 5, 50]) {
    const body = await captureRequest(() =>
      chatTurn({ profile: ANTHROPIC_PROFILE, system: "TEAM_GRUNDREGELN …", messages: loopHistory(turns) }),
    );
    const count = countBreakpoints(body);
    assert.ok(
      count <= 4,
      `erwartet: hoechstens 4 Markierer bei ${turns} Turns, gezaehlt ${count} – mehr beantwortet Anthropic mit 400`,
    );
  }
});

test("ein einzelner Frage-Antwort-Aufruf markiert nur den Systemprompt", async () => {
  const body = await captureRequest(() =>
    chat({ profile: ANTHROPIC_PROFILE, system: "TEAM_GRUNDREGELN …", prompt: "Bewerte diesen Diff." }),
  );

  // Der Prompt selbst (Diff, Ticket, Kontext) ist bei jedem Aufruf ein
  // anderer – ihn zu markieren wuerde nur den Schreibaufschlag kosten, ohne
  // dass ihn je jemand liest.
  assert.equal(countBreakpoints(body), 1);
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
});

test("im OpenAI-kompatiblen Pfad wird der Cache-Anteil aus den Eingabe-Tokens herausgerechnet", async () => {
  // Die Falle: `prompt_tokens` enthaelt hier die aus dem Cache bedienten
  // Tokens BEREITS (bei Anthropic ist `input_tokens` der Rest ohne sie).
  // Ohne die Subtraktion waere derselbe Aufruf je nach Anbieter anders zu
  // lesen und jede Kostenrechnung daraus falsch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 4800 } },
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const result = await chatTurn({
      profile: {
        name: "Test-Profil",
        provider: "GENERIC_OPENAI_COMPAT",
        model: "deepseek/deepseek-v4-flash-0731",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyRef: "test-key",
      },
      system: "TEAM_GRUNDREGELN …",
      messages: loopHistory(2),
    });
    assert.deepEqual(result.usage, {
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 4800,
      cacheWriteTokens: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Verbrauchszahlen kommen aus der Antwort zurueck, damit sich Treffer nachweisen lassen", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 4200, cache_creation_input_tokens: 0 },
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const result = await chatTurn({
      profile: ANTHROPIC_PROFILE,
      system: "TEAM_GRUNDREGELN …",
      messages: loopHistory(2),
    });
    assert.deepEqual(result.usage, {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 4200,
      cacheWriteTokens: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
