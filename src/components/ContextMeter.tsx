import { getContextWindow } from "@/lib/contextWindows";

/// Balken fuer "wie voll ist das Kontextfenster gerade" – Grundlage sind die
/// Verbrauchszahlen, die der Anbieter zu einem einzelnen Modellaufruf
/// mitschickt (siehe TokenUsage in src/lib/llm.ts, gespeichert auf
/// AgentRun.inputTokens/... seit worker/agentRun.ts).
///
/// Zeigt bewusst den STAND EINES EINZELNEN AgentRun, nicht eine Summe ueber
/// den ganzen Versuch: Im Tool-Loop (worker/agentToolLoop.ts) schickt jeder
/// Turn die GANZE bisherige Konversation erneut mit – `inputTokens` des
/// letzten Turns IST also schon die Groesse der gesamten Konversation.
/// Aufrufer reicht deshalb immer den letzten Turn eines Versuchs herein.
export function ContextMeter({
  model,
  usage,
}: {
  model: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  } | null;
}) {
  const contextWindow = getContextWindow(model);
  // Kein bekanntes Modell oder noch keine Verbrauchszahlen (z.B. Ollama meldet
  // keine, oder der Aufruf laeuft noch/ist gescheitert, bevor eine Antwort
  // kam) -> lieber gar kein Balken als einer mit geratenen Zahlen.
  if (!contextWindow || !usage || usage.inputTokens == null) return null;

  // Was der NAECHSTE Turn vorfinden wird: der komplette Prompt dieses Turns
  // (voll bezahlte Tokens + beide Cache-Anteile) plus die gerade erzeugte
  // Antwort, die der Tool-Loop als naechste Nachricht anhaengt.
  const used =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    (usage.outputTokens ?? 0);
  const ratio = Math.min(used / contextWindow, 1);
  const pct = Math.round(ratio * 100);
  const tone = ratio >= 0.85 ? "critical" : ratio >= 0.6 ? "warning" : "good";

  return (
    <div
      className="flex items-center gap-1.5"
      title={`Kontextfenster: ${used.toLocaleString("de-DE")} von ${contextWindow.toLocaleString(
        "de-DE",
      )} Tokens (${pct}%) – Stand letzter Modellaufruf`}
    >
      <span className="shrink-0 text-[11px] text-ink-3">Kontext</span>
      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: `var(--color-${tone})` }}
        />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{pct}%</span>
    </div>
  );
}
