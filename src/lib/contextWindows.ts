// Kontextfenstergroessen bekannter Modelle – reines Nachschlagen per
// Namensmuster, keine Anbieter-API liefert das zuverlaessig ab. Grundlage
// fuer den Kontextfenster-Balken im Nachweis (siehe ContextMeter,
// AttemptChat): zeigt, wie voll die Konversation im Verhaeltnis zum
// Limit des Modells ist.
//
// `LlmProfile.model` ist Freitext (jeder Nutzer kann jeden Modellnamen
// eintragen, auch fuer lokale Ollama-Container) – bei unbekanntem Namen lieber
// gar keinen Balken zeigen als eine geratene Grenze, die in die Irre fuehrt.
const KNOWN_CONTEXT_WINDOWS: [pattern: RegExp, tokens: number][] = [
  // Anthropic
  [/claude-.*(opus|sonnet|haiku)-[3-9]/i, 200_000],
  [/claude-3/i, 200_000],
  // OpenAI
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/\bo[1-4](-mini)?\b/i, 200_000],
  // OpenRouter/GENERIC_OPENAI_COMPAT-gaengige Modelle
  [/deepseek/i, 128_000],
  [/qwen/i, 128_000],
  [/llama-?3\.[1-3]/i, 128_000],
  [/mixtral/i, 32_000],
  [/gemini-1\.5|gemini-2/i, 1_000_000],
  [/gemini/i, 128_000],
  [/mistral-large/i, 128_000],
];

/** `null`, wenn das Modell nicht erkannt wird – dann bleibt der Balken aus. */
export function getContextWindow(model: string | null | undefined): number | null {
  if (!model) return null;
  for (const [pattern, tokens] of KNOWN_CONTEXT_WINDOWS) {
    if (pattern.test(model)) return tokens;
  }
  return null;
}
