import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { AgentRun, Agent, Ticket, Sprint } from "@/generated/prisma/client";
import { gitLog } from "@/lib/workspace";
import {
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_PILL,
  SPRINT_STATUS_LABEL,
} from "@/lib/labels";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";
import { splitIntoAttempts } from "@/lib/agentRunAttempts";
import { ActionForm } from "@/components/ActionForm";
import { IconSubmit } from "@/components/IconSubmit";
import { StopIcon } from "@/components/icons";
import { iconButtonDangerClass } from "@/lib/ui";
import { stopAgentRun } from "@/lib/actions/records";

// Die Belegablage des Projekts: jeder Agentenlauf mit Auftrag und Antwort,
// jeder Commit mit Diff, jede Sprint-Zusammenfassung. Was im Team-Büro als
// Zeile steht, lässt sich hier bis zur Quelle aufklappen – das ist der
// Unterschied zwischen "das Team sagt, es sei fertig" und Nachvollziehbarkeit.
//
// Drei Panels statt drei Abschnitte untereinander: Die Liste der Agentenläufe
// links wächst mit jedem Ticket, ohne die beiden anderen Belegarten
// wegzuschieben – sie steht vorn, weil sie zeigt, wie ein Commit zustande kam.
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
  const runRows = buildRunRows(runs);

  // `card-ghost` (siehe Büroplan in AgentWorkspacePanel.tsx): nur der Rahmen
  // bleibt sichtbar, die Kartenfläche wird transparent – dasselbe Geisterkarten-
  // Design jetzt auch hier, damit die Nachweis-Panels optisch zum Team-Büro passen.
  return (
    <PanelGrid className="lg:grid-cols-2 lg:grid-rows-2">
      <Panel title="Agentenläufe" count={runRows.length} className="card-ghost lg:row-span-2" padded={false}>
        {runRows.length === 0 ? (
          <PanelEmpty>Noch kein Agent tätig geworden.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {runRows.map((row) => {
              // Ein Umsetzungsversuch ist hier EINE Zeile, egal wie viele
              // Werkzeug-Turns er brauchte – Ziel ist die letzte davon, ihr
              // Nachweis zeigt (siehe getAttemptRuns) automatisch den ganzen
              // Verlauf als Chat.
              const run = row.kind === "attempt" ? row.runs[row.runs.length - 1] : row.run;
              return (
                <li key={run.id} className="flex items-stretch">
                  <Link
                    href={`/projects/${project.id}/records/runs/${run.id}`}
                    className="flex min-w-0 flex-1 items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    <span className="w-24 shrink-0 text-xs text-ink-4">{formatTime(run.startedAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {row.kind === "attempt" ? `Umsetzung${run.ticket ? `: ${run.ticket.title}` : ""}` : run.headline}
                      </span>
                      <span className="block truncate text-xs text-ink-3">
                        {run.agent?.name ?? "—"} · {RUN_KIND_LABEL[run.kind] ?? run.kind}
                        {run.model ? ` · ${run.model}` : ""}
                        {row.kind === "attempt"
                          ? ` · ${row.runs.length} Schritte`
                          : run.durationMs
                            ? ` · ${(run.durationMs / 1000).toFixed(1)} s`
                            : ""}
                        {row.kind !== "attempt" && run.ticket ? ` · ${run.ticket.title}` : ""}
                      </span>
                    </span>
                    <span className={`${RUN_STATUS_PILL[run.status]} shrink-0`}>
                      {RUN_STATUS_LABEL[run.status]}
                    </span>
                  </Link>
                  {/* Ausserhalb des Links: ein Absende-Knopf darin waere
                      verschachteltes interaktives Markup. Nur bei RUNNING
                      sichtbar – ein fertiger Lauf laesst sich nicht mehr
                      stoppen. */}
                  {run.status === "RUNNING" && (
                    <div className="flex items-center pr-3">
                      <ActionForm action={stopAgentRun}>
                        <input type="hidden" name="runId" value={run.id} />
                        <IconSubmit title="Lauf stoppen" className={iconButtonDangerClass}>
                          <StopIcon className="h-3.5 w-3.5" />
                        </IconSubmit>
                      </ActionForm>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Commits im Repository"
        count={commits.length}
        padded={false}
        className="card-ghost"
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

      <Panel title="Sprints" count={sprints.length} padded={false} className="card-ghost">
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

type RunWithRelations = AgentRun & { agent: Agent | null; ticket: Ticket | null; sprint: Sprint | null };
type RunRow = { kind: "single"; run: RunWithRelations } | { kind: "attempt"; runs: RunWithRelations[] };

// Fasst die Turns eines Umsetzungsversuchs (siehe worker/agentToolLoop.ts,
// splitIntoAttempts) zu EINER Zeile zusammen, statt jeden Werkzeugaufruf
// einzeln zu listen – bei 32 moeglichen Turns pro Ticket sonst schnell die
// meisten Zeilen dieses Panels. Alle anderen Laeufe (kickoff, review, ...)
// bleiben unveraendert einzelne Zeilen.
function buildRunRows(runs: RunWithRelations[]): RunRow[] {
  const byTicketKind = new Map<string, RunWithRelations[]>();
  const rows: RunRow[] = [];

  for (const run of runs) {
    if (run.ticketId && run.kind === "implementation") {
      const key = `${run.ticketId}:${run.kind}`;
      const list = byTicketKind.get(key);
      if (list) list.push(run);
      else byTicketKind.set(key, [run]);
    } else {
      rows.push({ kind: "single", run });
    }
  }

  for (const list of byTicketKind.values()) {
    const asc = [...list].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const attempt of splitIntoAttempts(asc)) {
      rows.push(attempt.length > 1 ? { kind: "attempt", runs: attempt } : { kind: "single", run: attempt[0] });
    }
  }

  const anchor = (row: RunRow) => (row.kind === "single" ? row.run : row.runs[row.runs.length - 1]).startedAt.getTime();
  return rows.sort((a, b) => anchor(b) - anchor(a));
}
