import assert from "node:assert/strict";
import test from "node:test";
import { chatTurn } from "../src/lib/llm";

// Regression für einen konkreten Vorfall im Drapbox-Projekt (20.08.2026):
// Der RunPod-Ollama-Server gab neben zwei echten `run_command`-Aufrufen einen
// erfundenen dritten strukturiert zurück ("drapbox-backend", ohne Argumente –
// der Name kam vermutlich aus einer verschachtelten JSON-Zeichenkette im
// content). Weil `toolCalls.length` dadurch schon > 0 war, lief der
// Klartext-Fallback bisher gar nicht mehr – drei echte `write_file`-Aufrufe,
// die das Modell im selben content als sauberes JSON aufgeschrieben hatte,
// blieben unerkannt liegen. Das Ticket drehte sich dadurch Anlauf für Anlauf
// im Kreis ("package.json fehlt" -> Plan, sie zu erstellen -> nie ausgeführt
// -> "package.json fehlt" von vorn).
test("erkennt Klartext-Tool-Aufrufe im content auch dann, wenn der Server schon (falsche) strukturierte Aufrufe liefert", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                'Erstelle die Datei `package.json`:\n\n```json\n{"name": "write_file", "arguments": {"path": "backend/package.json", "content": "{\\n  \\"name\\": \\"drapbox-backend\\"\\n}"}}\n```\n',
              tool_calls: [
                { id: "call_1", function: { name: "drapbox-backend", arguments: "{}" } },
                { id: "call_2", function: { name: "run_command", arguments: '{"command":"npm install","cwd":"backend"}' } },
              ],
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const result = await chatTurn({
      profile: {
        name: "Test-Profil",
        provider: "GENERIC_OPENAI_COMPAT",
        model: "qwen2.5-coder:32b",
        baseUrl: "https://example.invalid/v1",
        apiKeyRef: "test-key",
      },
      system: "Du bist ein Test.",
      messages: [{ role: "user", content: "Setz das Ticket um." }],
    });

    const names = result.toolCalls.map((call) => call.name);
    assert.deepEqual(names, ["drapbox-backend", "run_command", "write_file"]);
    const writeFile = result.toolCalls.find((call) => call.name === "write_file");
    assert.equal(writeFile?.input.path, "backend/package.json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
