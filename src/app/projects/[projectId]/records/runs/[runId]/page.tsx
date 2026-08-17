import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AGENT_ROLE_LABEL, RUN_KIND_LABEL, RUN_STATUS_LABEL, RUN_STATUS_PILL } from "@/lib/labels";
import { Panel, PanelGrid, PanelStrip } from "@/components/Panel";

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

  return (
    <>
      <PanelStrip>
        <div className="card flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
          <Link href={`/projects/${projectId}/records`} className="quiet-link text-xs font-medium">
            ← Nachweise
          </Link>
          <span className="font-medium text-ink">{run.headline}</span>
          <span className={RUN_STATUS_PILL[run.status]}>{RUN_STATUS_LABEL[run.status]}</span>
          <span className="text-xs text-ink-3">
            {RUN_KIND_LABEL[run.kind] ?? run.kind} ·{" "}
            {run.agent ? `${run.agent.name} (${AGENT_ROLE_LABEL[run.agent.role]})` : "unbekannter Agent"}
            {run.model ? ` · Modell: ${run.model}` : ""} · gestartet{" "}
            {run.startedAt.toLocaleString("de-DE")}
            {run.durationMs ? ` · Dauer ${(run.durationMs / 1000).toFixed(1)} s` : ""}
            {run.sprint ? ` · Sprint ${run.sprint.number}` : ""}
            {run.ticket ? ` · Ticket: ${run.ticket.title}` : ""}
          </span>
        </div>
      </PanelStrip>

      <PanelGrid className="lg:grid-cols-2">
        <Panel title={run.error ? "Fehler" : "Antwort des Agenten"} padded={false}>
          <pre
            className={`whitespace-pre-wrap p-4 text-sm leading-relaxed ${
              run.error ? "text-critical" : "text-ink-2"
            }`}
          >
            {run.error ?? run.response ?? "Keine Antwort protokolliert."}
          </pre>
          {run.error && run.response && (
            <div className="border-t border-hairline">
              <h3 className="section-title px-4 pb-1 pt-3">Antwort des Agenten</h3>
              <pre className="whitespace-pre-wrap p-4 pt-0 text-sm leading-relaxed text-ink-2">
                {run.response}
              </pre>
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
    </>
  );
}
