import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AGENT_ROLE_LABEL, RUN_KIND_LABEL, RUN_STATUS_LABEL, RUN_STATUS_PILL } from "@/lib/labels";
import { Panel, PanelGrid, PanelStrip } from "@/components/Panel";
import { AgentResponse } from "@/components/AgentResponse";
import { AttemptChat } from "@/components/AttemptChat";
import { ContextMeter } from "@/components/ContextMeter";
import { getAttemptRuns } from "@/lib/agentRunAttempts";

// Ein einzelner Agentenlauf, vollständig aufgeklappt: Rolle und Modell, der
// Auftrag an das Modell (Systemprompt + Prompt) und die Antwort im Wortlaut.
// Wer wissen will, warum ein Agent etwas so entschieden hat, liest hier nach –
// das ist die Rechenschaft hinter jeder Zeile im Protokoll.
//
// Antwort links, Auftrag rechts: Beides gehört nebeneinander gelesen, sonst
// scrollt man zwischen Frage und Antwort hin und her.
export const dynamic = "force-dynamic";

export default async function AgentRunPage({
  params,
}: PageProps<"/projects/[projectId]/records/runs/[runId]">) {
  const { projectId, runId } = await params;

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: true, ticket: true, sprint: true },
  });
  if (!run || run.projectId !== projectId) notFound();

  // Ein Umsetzungs-Loop (worker/agentToolLoop.ts) legt PRO TURN einen eigenen
  // AgentRun an – egal, welcher dieser Turns hier aufgerufen wurde, gezeigt
  // wird immer der GANZE Versuch als Verlauf (siehe getAttemptRuns): ein
  // "read_file" und die Antwort darauf sind ein Prozessschritt, kein Grund,
  // zwei Nachweise nacheinander aufzuklappen.
  const attempt = await getAttemptRuns(run);
  const isAttempt = attempt.length > 1;
  // Der letzte Turn mit Verbrauchszahlen: waehrend der aktuellste Turn noch
  // laeuft (RUNNING, noch keine Antwort) hat der selbst noch keine – dann
  // lieber den zuletzt bekannten Fuellstand zeigen als den Balken kurz
  // verschwinden zu lassen.
  const lastMeasuredRun = [...attempt].reverse().find((r) => r.inputTokens != null) ?? null;

  return (
    <>
      <PanelStrip>
        <div className="card flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
          <Link href={`/projects/${projectId}/records`} className="quiet-link text-xs font-medium">
            ← Nachweise
          </Link>
          <span className="font-medium text-ink">
            {isAttempt ? `Umsetzung${run.ticket ? `: ${run.ticket.title}` : ""}` : run.headline}
          </span>
          <span className={RUN_STATUS_PILL[attempt[attempt.length - 1].status]}>
            {RUN_STATUS_LABEL[attempt[attempt.length - 1].status]}
          </span>
          <ContextMeter model={lastMeasuredRun?.model ?? null} usage={lastMeasuredRun} />
          <span className="text-xs text-ink-3">
            {RUN_KIND_LABEL[run.kind] ?? run.kind} ·{" "}
            {run.agent ? `${run.agent.name} (${AGENT_ROLE_LABEL[run.agent.role]})` : "unbekannter Agent"}
            {run.model ? ` · Modell: ${run.model}` : ""} · gestartet{" "}
            {attempt[0].startedAt.toLocaleString("de-DE")}
            {isAttempt
              ? ` · ${attempt.length} Schritte`
              : run.durationMs
                ? ` · Dauer ${(run.durationMs / 1000).toFixed(1)} s`
                : ""}
            {run.sprint ? ` · Sprint ${run.sprint.number}` : ""}
            {run.ticket ? ` · Ticket: ${run.ticket.title}` : ""}
          </span>
        </div>
      </PanelStrip>

      {isAttempt ? (
        // Eigenes PanelGrid mit nur einer Spalte: erst dadurch bekommt das
        // Panel eine Hoehenbegrenzung (siehe <PanelGrid>) und scrollt seinen
        // Rumpf selbst – sonst wuerde die Seite mit jeder Chatnachricht immer
        // laenger, statt an Ort und Stelle zu scrollen.
        <PanelGrid className="lg:grid-cols-1">
          <Panel title="Verlauf" count={attempt.length} padded={false}>
            <h3 className="section-title px-4 pb-1 pt-3">Systemprompt</h3>
            <details className="px-4 pb-3">
              <summary className="cursor-pointer text-sm text-ink-3 hover:text-ink-2">
                gilt für den ganzen Versuch (aufklappen)
              </summary>
              <pre className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{run.systemPrompt}</pre>
            </details>
            <div className="border-t border-hairline px-4 py-4">
              <AttemptChat runs={attempt} />
            </div>
          </Panel>
        </PanelGrid>
      ) : (
        <PanelGrid className="lg:grid-cols-2">
          <Panel title={run.error ? "Fehler" : "Antwort des Agenten"} padded={false}>
            {run.error ? (
              <pre className="whitespace-pre-wrap p-4 text-sm leading-relaxed text-critical">{run.error}</pre>
            ) : run.response ? (
              <AgentResponse text={run.response} className="p-4" />
            ) : (
              <p className="p-4 text-sm leading-relaxed text-ink-2">Keine Antwort protokolliert.</p>
            )}
            {run.error && run.response && (
              <div className="border-t border-hairline">
                <h3 className="section-title px-4 pb-1 pt-3">Antwort des Agenten</h3>
                <AgentResponse text={run.response} className="px-4 pb-4 pt-0" />
              </div>
            )}
          </Panel>

          <Panel title="Auftrag an das Modell" padded={false}>
            <h3 className="section-title px-4 pb-1 pt-3">Systemprompt</h3>
            <pre className="whitespace-pre-wrap px-4 pb-4 text-sm leading-relaxed text-ink-2">
              {run.systemPrompt}
            </pre>
            <div className="border-t border-hairline">
              <h3 className="section-title px-4 pb-1 pt-3">Übergebener Projektstand</h3>
              <pre className="whitespace-pre-wrap px-4 pb-4 text-sm leading-relaxed text-ink-2">
                {run.prompt}
              </pre>
            </div>
          </Panel>
        </PanelGrid>
      )}
    </>
  );
}
