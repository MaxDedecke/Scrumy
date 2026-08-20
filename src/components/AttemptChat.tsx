"use client";

import { useEffect, useRef } from "react";
import type { AgentRun } from "@/generated/prisma/client";
import { AgentResponse } from "@/components/AgentResponse";

// Ein Umsetzungsversuch als Chatverlauf statt als Stapel einzelner Nachweise:
// Jeder Turn (siehe worker/agentToolLoop.ts) war bisher ein eigener Nachweis
// mit eigener Seite – ein "read_file" und die darauf folgende Antwort des
// Modells sind aber ein einziger Prozessschritt, kein Grund, zwei Nachweise
// nacheinander aufzuklappen. Hier stehen alle Turns eines Versuchs
// untereinander: das Werkzeugergebnis, das den Turn ausgeloest hat, rechts
// (wie eine Nachricht an das Modell), die Antwort des Modells links – gleiche
// Bildsprache wie <TeamChatPanel>.
//
// Turn 1 traegt den vollen Auftrag ("# Projekt...", siehe
// `buildProjectContext`) statt eines Werkzeugergebnisses – deutlich laenger
// als jeder Folge-Turn und bei jedem Versuch wortgleich, deshalb per
// <details> eingeklappt statt den Verlauf zu dominieren.
export function AttemptChat({ runs, className }: { runs: AgentRun[]; className?: string }) {
  // Beim Öffnen interessiert nur der letzte Schritt – ohne das hier landet
  // man immer oben beim "Ursprünglicher Auftrag" und muss sich erst durch den
  // ganzen Verlauf scrollen. `scrollIntoView` statt `scrollTo(0, hoehe)`,
  // weil so auch dann noch die richtige Stelle getroffen wird, wenn sich
  // (z.B. durch spaeteres Nachladen) die Panelhoehe nochmal aendert.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  return (
    // `min-h-[50vh]`: Auf dem Handy hebt <PanelGrid> die Höhenbegrenzung des
    // Panels bewusst auf (siehe dortiger Kommentar), der Verlauf waechst dort
    // also mit der Seite statt selbst zu scrollen. Ohne eigene Mindesthöhe
    // waere ein kurzer Versuch (1-2 Turns) dann nur ein winziger Streifen –
    // die Mindesthöhe sorgt fuer eine ordentliche Lesehöhe, auch wenn wenig
    // Inhalt da ist.
    <div className={`flex min-h-[50vh] flex-col gap-3 ${className ?? ""}`}>
      {runs.map((run, i) => (
        <div key={run.id} className="flex flex-col gap-1.5">
          <div className="max-w-[92%] self-end rounded-2xl rounded-br-sm border border-accent-border bg-accent-soft px-3 py-2">
            <p className="text-[11px] font-medium text-ink-3">
              {i === 0 ? "Ursprünglicher Auftrag" : `Werkzeugergebnis · Schritt ${i + 1}`} ·{" "}
              {formatTime(run.startedAt)}
            </p>
            <PromptBody text={run.prompt} collapseByDefault={i === 0} />
          </div>

          <div className="max-w-[92%] self-start rounded-2xl rounded-bl-sm border border-hairline bg-surface-2 px-3 py-2">
            <p className="text-[11px] font-medium text-ink-3">
              Schritt {i + 1}
              {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)} s` : ""}
            </p>
            {run.error ? (
              <pre className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-critical">{run.error}</pre>
            ) : run.response ? (
              <AgentResponse text={run.response} className="mt-1" />
            ) : (
              <p className="mt-1 text-sm text-ink-3">Keine Antwort protokolliert.</p>
            )}
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/// Werkzeugergebnisse (z.B. ein gelesener Dateiinhalt) koennen genauso lang
/// werden wie der urspruengliche Auftrag – ab derselben Schwelle wird
/// eingeklappt, unabhaengig davon, ob es Turn 1 ist oder nicht.
const COLLAPSE_THRESHOLD = 480;

function PromptBody({ text, collapseByDefault }: { text: string; collapseByDefault: boolean }) {
  const body = (
    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">{text}</pre>
  );
  if (!collapseByDefault && text.length <= COLLAPSE_THRESHOLD) {
    return <div className="mt-1">{body}</div>;
  }
  const preview = text.trim().split("\n")[0].slice(0, 100);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-sm text-ink-3 hover:text-ink-2">
        {preview || "…"} (aufklappen)
      </summary>
      <div className="mt-1.5">{body}</div>
    </details>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
