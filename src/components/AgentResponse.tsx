// Formatiert eine geloggte Agentenantwort lesbar statt als eine lange
// Fliesstext-Zeile – siehe `loggedResponse` in worker/agentRun.ts:
//   * Fliesstext bleibt Fliesstext, Markdown-Codebloecke (```…```) und
//     `Inline-Code` werden als eigener monospaced Block bzw. Span gezeigt.
//   * Protokollierte Werkzeugaufrufe ("→ name({...json...})") werden
//     geparst statt roh gezeigt: der Aufruf als Kopfzeile, code-artige
//     Argumente (Dateiinhalt, Suchen/Ersetzen, Shell-Befehl, …) je als
//     eigener Block MIT echten Zeilenumbrüchen statt der von
//     JSON.stringify escapten "\n".
// Kein Markdown-Parser für Ueberschriften/Listen – Agentenantworten sind
// kurze Statusprosa, dafuer lohnt sich keine zusaetzliche Abhaengigkeit; nur
// Code ist das, was hier tatsaechlich unlesbar wird.
import type { ReactNode } from "react";

/// Passt exakt auf eine Zeile aus `→ ${call.name}(${JSON.stringify(call.input)})`
/// (siehe worker/agentRun.ts) – `JSON.stringify` erzeugt nie ein rohes
/// Zeilenumbruchszeichen, jeder Aufruf steht also garantiert auf genau einer
/// Zeile. Das gierige `.*` matcht bis zur LETZTEN "(" auf der Zeile, das ist
/// dank des balancierten JSON immer die schliessende Klammer des Aufrufs
/// selbst, auch wenn ein Argument (z.B. Code) eigene runde Klammern enthält.
const TOOL_CALL_LINE = /^→ ([\w.]+)\((.*)\)$/;

/// Argumentnamen, die laut worker/agentTools.ts typischerweise mehrzeiligen
/// Code/Text tragen – die werden immer als Codeblock dargestellt, auch wenn
/// sie im Einzelfall kurz/einzeilig sind (z.B. ein einzeiliger Shell-Befehl).
const CODE_ARG_KEYS = new Set(["content", "search", "replace", "command", "query"]);

const FENCE = /```(\w*)\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;

type Segment =
  | { kind: "prose"; text: string }
  | { kind: "call"; name: string; args: Record<string, unknown> | null; raw: string };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let proseLines: string[] = [];

  const flushProse = () => {
    const joined = proseLines.join("\n").trim();
    if (joined) segments.push({ kind: "prose", text: joined });
    proseLines = [];
  };

  for (const line of text.split("\n")) {
    const match = line.match(TOOL_CALL_LINE);
    if (!match) {
      proseLines.push(line);
      continue;
    }
    flushProse();
    const [, name, argsRaw] = match;
    let args: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Kein gueltiges JSON – bei einer echten JSON.stringify-Ausgabe
      // sollte das nie passieren, ToolCallBlock faellt dann auf die
      // Rohzeile zurueck statt etwas zu erfinden.
    }
    segments.push({ kind: "call", name, args, raw: line });
  }
  flushProse();
  return segments;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    nodes.push(
      <code key={`${keyPrefix}-i${i}`} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.8125em]">
        {match[1]}
      </code>,
    );
    last = index + match[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/// `nested`: innerhalb eines <ToolCallBlock> (dessen Kachel bereits selbst
/// die Flaeche traegt) bewusst OHNE eigenen Rahmen/Hintergrund – sonst steht
/// eine Karte in der Karte (z.B. "search"/"replace" beide in edit_file).
/// Nur der grosse, freistehende Codeblock im Fliesstext bekommt seine
/// eigene Kachel.
function CodeBlock({ code, label, nested = false }: { code: string; label?: string; nested?: boolean }) {
  if (nested) {
    return (
      <div className="flex flex-col gap-1">
        {label && <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-4">{label}</div>}
        <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-ink-2">{code}</pre>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface-2/60">
      {label && (
        <div className="border-b border-hairline px-3 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-4">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-ink-2">{code}</pre>
    </div>
  );
}

function renderProse(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(FENCE)) {
    const index = match.index ?? 0;
    if (index > last) {
      const chunk = text.slice(last, index).trim();
      if (chunk) {
        nodes.push(
          <p key={`${keyPrefix}-t${i}`} className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
            {renderInline(chunk, `${keyPrefix}-t${i}`)}
          </p>,
        );
      }
    }
    nodes.push(<CodeBlock key={`${keyPrefix}-c${i}`} code={match[2].replace(/\n$/, "")} label={match[1] || undefined} />);
    last = index + match[0].length;
    i++;
  }
  const rest = text.slice(last).trim();
  if (rest) {
    nodes.push(
      <p key={`${keyPrefix}-t${i}`} className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
        {renderInline(rest, `${keyPrefix}-t${i}`)}
      </p>,
    );
  }
  return nodes;
}

function ToolCallBlock({
  name,
  args,
  raw,
  keyPrefix,
}: {
  name: string;
  args: Record<string, unknown> | null;
  raw: string;
  keyPrefix: string;
}) {
  if (!args) {
    return <pre className="overflow-x-auto rounded-lg border border-hairline bg-surface-2/60 p-3 font-mono text-xs text-ink-3">{raw}</pre>;
  }

  const path = typeof args.path === "string" ? args.path : null;
  const entries = Object.entries(args).filter(([key]) => key !== "path");

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface-2/60">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-3 py-1.5 text-xs">
        <span className="font-mono font-semibold text-accent">{name}</span>
        {path && <span className="font-mono text-ink-3">{path}</span>}
      </div>
      {entries.length > 0 && (
        <div className="flex flex-col divide-y divide-hairline/50 px-3 [&>*]:py-2.5">
          {entries.map(([key, value], i) => {
            const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            const multiline = text.includes("\n") || text.length > 80;
            if (CODE_ARG_KEYS.has(key) || multiline) {
              return <CodeBlock key={`${keyPrefix}-a${i}`} code={text} label={key} nested />;
            }
            return (
              <p key={`${keyPrefix}-a${i}`} className="font-mono text-xs text-ink-3">
                <span className="text-ink-4">{key}:</span> {text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentResponse({ text, className }: { text: string; className?: string }) {
  const segments = parseSegments(text);
  if (segments.length === 0) return null;

  return (
    <div className={`flex flex-col gap-3 ${className ?? ""}`}>
      {segments.map((segment, i) =>
        segment.kind === "prose" ? (
          <div key={`s${i}`} className="flex flex-col gap-2">
            {renderProse(segment.text, `s${i}`)}
          </div>
        ) : (
          <ToolCallBlock key={`s${i}`} name={segment.name} args={segment.args} raw={segment.raw} keyPrefix={`s${i}`} />
        ),
      )}
    </div>
  );
}
