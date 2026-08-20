import assert from "node:assert/strict";
import test from "node:test";
import { chat } from "../src/lib/llm";

// Regression für den Drapbox-Stillstand (20.08.2026): `checkAlreadySatisfied`
// (worker/tasks/ticketWork.ts) ruft mit einem knappen `maxTokens: 300` auf,
// weil nur ein kurzes JSON-Urteil erwartet wird. Über den OpenAI-kompatiblen
// Endpunkt (GENERIC_OPENAI_COMPAT, z.B. deepseek-v4-flash) zählt das
// Nachdenken eines Reasoning-Modells aber in dasselbe Budget – die Antwort
// riss deshalb reihenweise mitten im JSON ab (`finish_reason: "length"`,
// TOKEN_LIMIT), bis das Ticket alle Anläufe verbraucht hatte und das ganze
// Team auf eine Klärung wartete. Der Anthropic-Pfad hat dafür schon einen
// großzügigen Mindestwert (`Math.max(maxTokens, 16000)`) – dieser Test
// erzwingt dieselbe Untergrenze für den OpenAI-kompatiblen Pfad.
test("chat hebt ein knappes maxTokens im OpenAI-kompatiblen Pfad auf die großzügige Untergrenze an", async () => {
  const originalFetch = globalThis.fetch;
  let sentMaxTokens: number | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sentMaxTokens = body.max_tokens;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"satisfied": false, "reason": "test"}' }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    await chat({
      profile: {
        name: "Test-Profil",
        provider: "GENERIC_OPENAI_COMPAT",
        model: "deepseek/deepseek-v4-flash-0731",
        baseUrl: "https://example.invalid/v1",
        apiKeyRef: "test-key",
      },
      system: "Du bist ein Test.",
      prompt: "Sag etwas.",
      maxTokens: 300,
    });
    assert.equal(sentMaxTokens, 16000, "erwartet: knappes maxTokens wird auf die 16000er-Untergrenze angehoben");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
