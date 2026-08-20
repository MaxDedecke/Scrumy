import assert from "node:assert/strict";
import test from "node:test";
import { chat } from "../src/lib/llm";

// Regression für den RunPod-524-Vorfall im Drapbox-Projekt (20.08.2026): Ein
// einzelner Cloudflare-524 vom RunPod-Proxy hat den Anlauf sofort scheitern
// lassen, obwohl der Anbieter beim nächsten Versuch normal geantwortet hätte.
// `postJson` (src/lib/llm.ts) versucht seither bei 429/502/503/504/524 (und
// bei Netzwerkfehlern) automatisch bis zu zweimal erneut, bevor es aufgibt.
test("postJson versucht es nach einem 524 automatisch erneut, statt sofort aufzugeben", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("<!DOCTYPE html><title>524: A timeout occurred</title>", { status: 524 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "erfolgreiche Antwort nach Retry" }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await chat({
      profile: {
        name: "Test-Profil",
        provider: "GENERIC_OPENAI_COMPAT",
        model: "qwen2.5-coder:32b",
        baseUrl: "https://example.invalid/v1",
        apiKeyRef: "test-key",
      },
      system: "Du bist ein Test.",
      prompt: "Sag etwas.",
    });
    assert.equal(result, "erfolgreiche Antwort nach Retry");
    assert.equal(calls, 2, "erwartet: erster Versuch scheitert mit 524, zweiter Versuch klappt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
