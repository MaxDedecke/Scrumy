import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AGENT_ROLE_LABEL, RUN_KIND_LABEL, RUN_STATUS_LABEL, RUN_STATUS_PILL } from "@/lib/labels";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { pageClass } from "@/lib/ui";

// Ein einzelner Agentenlauf, vollständig aufgeklappt: Rolle und Modell, der
// Auftrag an das Modell (Systemprompt + Prompt) und die Antwort im Wortlaut.
// Wer wissen will, warum ein Agent etwas so entschieden hat, liest hier nach –
// das ist die Rechenschaft hinter jeder Zeile im Protokoll.
export const dynamic = "force-dynamic";

export default async function AgentRunPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agent: true, ticket: true, sprint: true, project: { include: { organization: true } } },
  });
  if (!run || run.projectId !== projectId) notFound();

  return (
    <main className={pageClass}>
      <PageHeader
        backHref={`/projects/${projectId}/records`}
        backLabel="Nachweise"
        context={run.project.organization.name}
        title={run.headline}
        status={<span className={RUN_STATUS_PILL[run.status]}>{RUN_STATUS_LABEL[run.status]}</span>}
        description={
          `${RUN_KIND_LABEL[run.kind] ?? run.kind} · ${run.agent ? `${run.agent.name} (${AGENT_ROLE_LABEL[run.agent.role]})` : "unbekannter Agent"}` +
          `${run.model ? ` · Modell: ${run.model}` : ""}` +
          ` · gestartet ${run.startedAt.toLocaleString("de-DE")}` +
          `${run.durationMs ? ` · Dauer ${(run.durationMs / 1000).toFixed(1)} s` : ""}`
        }
      />

      {(run.ticket || run.sprint) && (
        <p className="mb-7 text-sm text-ink-3">
          {run.sprint && <>Sprint {run.sprint.number}: {run.sprint.goal}</>}
          {run.ticket && (
            <>
              {run.sprint ? " · " : ""}Ticket:{" "}
              <Link href={`/projects/${projectId}`} className="text-accent underline underline-offset-2">
                {run.ticket.title}
              </Link>
            </>
          )}
        </p>
      )}

      {run.error && (
        <Section title="Fehler">
          <pre className="card whitespace-pre-wrap p-5 text-sm leading-relaxed text-critical">{run.error}</pre>
        </Section>
      )}

      {run.response && (
        <Section title="Antwort des Agenten">
          <pre className="card whitespace-pre-wrap p-5 text-sm leading-relaxed text-ink-2">{run.response}</pre>
        </Section>
      )}

      <Section title="Auftrag an das Modell (Systemprompt)">
        <pre className="card whitespace-pre-wrap p-5 text-sm leading-relaxed text-ink-2">{run.systemPrompt}</pre>
      </Section>

      <Section title="Übergebener Projektstand (Prompt)" className="mb-0">
        <pre className="card whitespace-pre-wrap p-5 text-sm leading-relaxed text-ink-2">{run.prompt}</pre>
      </Section>
    </main>
  );
}
