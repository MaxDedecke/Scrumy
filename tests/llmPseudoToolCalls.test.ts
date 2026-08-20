import assert from "node:assert/strict";
import test from "node:test";
import { parsePseudoToolCalls } from "../src/lib/llm";

// Regression für einen konkreten Vorfall im DemoLogin-Projekt (20.08.2026,
// siehe Kommentar bei extractBareJsonToolCalls in src/lib/llm.ts): Ein
// edit_file-Aufruf kam als nacktes JSON-Objekt in message.content statt in
// tool_calls zurück. Das `search`-Argument war ein einzeiliger Anker mit
// einer unverschlossenen `{` ("exports.register = async (req, res) => {"),
// was die alte, string-unbewusste Klammerzählung aus dem Gleichgewicht
// brachte: Sie fand nie wieder Tiefe 0 und ließ den ganzen Aufruf als
// Fließtext stehen – zwei Runden lang, bis das Turn-Budget aufgebraucht war.
test("erkennt nacktes JSON mit unbalancierten Klammern im search-Argument", () => {
  const raw = {
    name: "edit_file",
    arguments: {
      path: "backend/controllers/authController.js",
      search: "exports.register = async (req, res) => {",
      replace:
        "exports.register = async (req, res) => {\n" +
        "  try {\n" +
        "    const { username, password } = req.body;\n" +
        "    if (!username || !password) {\n" +
        "      return res.status(400).json({ message: 'Username and password are required' });\n" +
        "    }\n" +
        "  } catch (error) {\n" +
        "    res.status(500).json({ message: 'Internal server error' });\n" +
        "  }\n" +
        "};\n" +
        "\n" +
        "exports.login = async (req, res) => {\n" +
        "  res.status(200).json({});\n" +
        "};\n",
    },
  };
  const text = `Nun implementiere ich die login-Funktion:\n\n${JSON.stringify(raw)}`;

  const result = parsePseudoToolCalls(text);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "edit_file");
  assert.equal(result.toolCalls[0].input.path, raw.arguments.path);
  assert.equal(result.toolCalls[0].input.search, raw.arguments.search);
  assert.equal(result.toolCalls[0].input.replace, raw.arguments.replace);
  assert.ok(!result.text.includes('"name"'), "JSON-Block muss aus dem Resttext entfernt sein");
});

test("lässt normalen Fließtext mit einzelnen geschweiften Klammern unangetastet", () => {
  const text = "Nutze { als Platzhalter, das ist kein Werkzeugaufruf.";
  const result = parsePseudoToolCalls(text);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.text, text);
});
