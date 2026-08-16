import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { gitLog } from "@/lib/workspace";
import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_PILL,
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_PILL,
  SPRINT_STATUS_LABEL,
} from "@/lib/labels";
import { PageHeader } from "@/components/PageHeader";
import { ProjectTabs } from "@/components/ProjectTabs";
import { EmptyHint, Section } from "@/components/Section";
import { pageClass } from "@/lib/ui";

// Die Belegablage des Projekts: jeder Agentenlauf mit Auftrag und Antwort,
// jeder Commit mit Diff, jede Sprint-Zusammenfassung. Was im Team-Büro als
// Zeile steht, lässt sich hier bis zur Quelle aufklappen – das ist der
// Unterschied zwischen "das Team sagt, es sei fertig" und Nachvollziehbarkeit.
export const dynamic = "force-dynamic";

export default async function ProjectRecordsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { organization: true },
  });
  if (!project) notFound();

  const [runs, sprints, activityCount] = await Promise.all([
    prisma.agentRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: { agent: true, ticket: true, sprint: true },
    }),
    prisma.sprint.findMany({ where: { projectId }, orderBy: { number: "desc" }, include: { tickets: true } }),
    prisma.activityLogEntry.count({ where: { OR: [{ projectId }, { ticket: { projectId } }] } }),
  ]);

  const commits = project.workspacePath ? await gitLog(project.workspacePath, 100) : [];

  return (
    <main className={pageClass}>
      <PageHeader
        backHref={`/projects/${project.id}/office`}
        backLabel="Team-Büro"
        context={project.organization.name}
        title={project.name}
        status={
          <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
            {PROJECT_STATUS_LABEL[project.status]}
          </span>
        }
        description={`${runs.length} protokollierte Agentenläufe · ${commits.length} Commits · ${activityCount} Protokolleinträge${
          project.workspacePath ? ` · Repository: ${project.workspacePath}` : ""
        }`}
      />

      <ProjectTabs projectId={project.id} active="records" />

      <Section title="Commits im Repository">
        {commits.length === 0 ? (
          <EmptyHint>Noch keine Commits – das Team hat das Repository noch nicht angelegt.</EmptyHint>
        ) : (
          <ul className="card divide-y divide-hairline">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <Link
                  href={`/projects/${project.id}/records/commits/${commit.sha}`}
                  className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
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
      </Section>

      <Section title="Agentenläufe">
        {runs.length === 0 ? (
          <EmptyHint>Noch kein Agent tätig geworden.</EmptyHint>
        ) : (
          <ul className="card divide-y divide-hairline">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/projects/${project.id}/records/runs/${run.id}`}
                  className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
                >
                  <span className="w-28 shrink-0 text-xs text-ink-4">{formatTime(run.startedAt)}</span>
                  <span className="w-32 shrink-0 truncate text-xs text-ink-3">{run.agent?.name ?? "—"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{run.headline}</span>
                    <span className="text-xs text-ink-3">
                      {RUN_KIND_LABEL[run.kind] ?? run.kind}
                      {run.model ? ` · ${run.model}` : ""}
                      {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)} s` : ""}
                      {run.ticket ? ` · Ticket: ${run.ticket.title}` : ""}
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
      </Section>

      <Section title="Sprints" className="mb-0">
        {sprints.length === 0 ? (
          <EmptyHint>Noch kein Sprint abgeschlossen.</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {sprints.map((sprint) => (
              <li key={sprint.id} className="card p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-ink">
                    Sprint {sprint.number} – {sprint.goal}
                  </p>
                  <p className="text-xs text-ink-3">
                    {SPRINT_STATUS_LABEL[sprint.status]} ·{" "}
                    {sprint.tickets.filter((ticket) => ticket.status === "DONE").length}/{sprint.tickets.length}{" "}
                    Tickets fertig · gestartet {formatTime(sprint.startedAt)}
                  </p>
                </div>
                {sprint.summary && (
                  <details className="mt-3">
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
      </Section>
    </main>
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
