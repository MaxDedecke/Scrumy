import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { gitLog } from "@/lib/workspace";
import {
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_PILL,
  SPRINT_STATUS_LABEL,
} from "@/lib/labels";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";

// Die Belegablage des Projekts: jeder Agentenlauf mit Auftrag und Antwort,
// jeder Commit mit Diff, jede Sprint-Zusammenfassung. Was im Team-Büro als
// Zeile steht, lässt sich hier bis zur Quelle aufklappen – das ist der
// Unterschied zwischen "das Team sagt, es sei fertig" und Nachvollziehbarkeit.
//
// Drei Panels statt drei Abschnitte untereinander: Die Commit-Liste links wird
// mit jedem Sprint länger, ohne die beiden anderen Belegarten wegzuschieben.
export const dynamic = "force-dynamic";

export default async function ProjectRecordsPage({
  params,
}: PageProps<"/projects/[projectId]/records">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspacePath: true },
  });
  if (!project) notFound();

  const [runs, sprints] = await Promise.all([
    prisma.agentRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: { agent: true, ticket: true, sprint: true },
    }),
    prisma.sprint.findMany({
      where: { projectId },
      orderBy: { number: "desc" },
      include: { tickets: true },
    }),
  ]);

  const commits = project.workspacePath ? await gitLog(project.workspacePath, 100) : [];

  return (
    <PanelGrid className="lg:grid-cols-2 lg:grid-rows-2">
      <Panel
        title="Commits im Repository"
        count={commits.length}
        className="lg:row-span-2"
        padded={false}
        action={
          project.workspacePath && (
            <span className="truncate font-mono text-ink-4" title={project.workspacePath}>
              {project.workspacePath}
            </span>
          )
        }
      >
        {commits.length === 0 ? (
          <PanelEmpty>Noch keine Commits – das Team hat das Repository noch nicht angelegt.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <Link
                  href={`/projects/${project.id}/records/commits/${commit.sha}`}
                  className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                >
                  <code className="mt-0.5 shrink-0 text-xs text-ink-4">{commit.shortSha}</code>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{commit.subject}</span>
                    <span className="text-xs text-ink-3">
                      {commit.author} · {formatTime(commit.date)} · {commit.files.length} Dateien
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Agentenläufe" count={runs.length} padded={false}>
        {runs.length === 0 ? (
          <PanelEmpty>Noch kein Agent tätig geworden.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/projects/${project.id}/records/runs/${run.id}`}
                  className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                >
                  <span className="w-24 shrink-0 text-xs text-ink-4">{formatTime(run.startedAt)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{run.headline}</span>
                    <span className="block truncate text-xs text-ink-3">
                      {run.agent?.name ?? "—"} · {RUN_KIND_LABEL[run.kind] ?? run.kind}
                      {run.model ? ` · ${run.model}` : ""}
                      {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)} s` : ""}
                      {run.ticket ? ` · ${run.ticket.title}` : ""}
                    </span>
                  </span>
                  <span className={`${RUN_STATUS_PILL[run.status]} shrink-0`}>
                    {RUN_STATUS_LABEL[run.status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Sprints" count={sprints.length} padded={false}>
        {sprints.length === 0 ? (
          <PanelEmpty>Noch kein Sprint abgeschlossen.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {sprints.map((sprint) => (
              <li key={sprint.id} className="px-4 py-3">
                <p className="text-sm font-medium text-ink">
                  Sprint {sprint.number} – {sprint.goal}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {SPRINT_STATUS_LABEL[sprint.status]} ·{" "}
                  {sprint.tickets.filter((ticket) => ticket.status === "DONE").length}/
                  {sprint.tickets.length} Tickets fertig · gestartet {formatTime(sprint.startedAt)}
                </p>
                {sprint.summary && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-accent">Review lesen</summary>
                    <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                      {sprint.summary}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PanelGrid>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
