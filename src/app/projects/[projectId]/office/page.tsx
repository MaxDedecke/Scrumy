import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  ACTIVITY_ACTION_LABEL,
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_PILL,
  INQUIRY_STATUS_LABEL,
  PRIORITY_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_PILL,
  RUN_KIND_LABEL,
  SPRINT_STATUS_LABEL,
  SPRINT_STATUS_PILL,
  TICKET_STATUS_LABEL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/PageHeader";
import { ProjectTabs } from "@/components/ProjectTabs";
import { EmptyHint, Section } from "@/components/Section";
import { askTeam, decideReview, nudgeTeam, pauseTeam, resumeTeam, setAutopilot } from "@/lib/actions/team";
import {
  buttonDangerClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
  pageClass,
} from "@/lib/ui";

// Der Raum, in den der Auftraggeber geht, wenn er wissen will, was läuft:
// Wer arbeitet gerade woran, wie weit ist der Sprint, was wartet auf ihn – und
// die Möglichkeit, dem Team direkt eine Frage zu stellen.
export const dynamic = "force-dynamic";

export default async function TeamOfficePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      organization: true,
      agents: { include: { agent: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  const [sprint, runningRuns, lastRuns, activity, pendingReviews, inquiries] = await Promise.all([
    prisma.sprint.findFirst({
      where: { projectId },
      orderBy: { number: "desc" },
      include: { tickets: { include: { assignee: true }, orderBy: { createdAt: "asc" } } },
    }),
    prisma.agentRun.findMany({ where: { projectId, status: "RUNNING" }, include: { agent: true } }),
    prisma.agentRun.findMany({ where: { projectId }, orderBy: { startedAt: "desc" }, take: 40 }),
    prisma.activityLogEntry.findMany({
      where: { OR: [{ projectId }, { ticket: { projectId } }] },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.reviewApproval.findMany({
      where: { decision: "PENDING", ticket: { projectId } },
      include: { ticket: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.teamInquiry.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { answeredBy: true },
    }),
  ]);

  const runningByAgent = new Map(runningRuns.map((run) => [run.agentId ?? "", run]));
  const lastRunByAgent = new Map<string, (typeof lastRuns)[number]>();
  for (const run of lastRuns) {
    if (run.agentId && !lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, run);
  }

  const started = project.status === "ACTIVE" || project.status === "PAUSED";
  const doneTickets = sprint?.tickets.filter((ticket) => ticket.status === "DONE").length ?? 0;
  const totalTickets = sprint?.tickets.length ?? 0;
  const busy = runningRuns.length > 0;

  return (
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context={project.organization.name}
        title={project.name}
        status={
          <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
            {PROJECT_STATUS_LABEL[project.status]}
          </span>
        }
        actions={<LiveRefresh />}
      />

      <ProjectTabs projectId={project.id} active="office" />

      {!started ? (
        <p className="rounded-xl border border-accent-border bg-accent-soft px-4 py-3 text-sm text-accent">
          Das Team hat noch nicht angefangen.{" "}
          <Link
            href={`/projects/${project.id}/discovery`}
            className="font-medium underline underline-offset-2 hover:text-ink"
          >
            Konzept und Anforderungen freigeben und Team starten
          </Link>
          .
        </p>
      ) : (
        <>
          <Section title="Steuerung">
            <div className="card flex flex-wrap items-center gap-3 p-5">
              <p className="mr-auto text-sm text-ink-2">
                {busy ? (
                  <>
                    <span className="font-medium text-ink">Das Team arbeitet gerade.</span>{" "}
                    {runningRuns.length} laufende{runningRuns.length === 1 ? "r Schritt" : " Schritte"}.
                  </>
                ) : project.status === "PAUSED" ? (
                  "Die Arbeit ruht – niemand im Team nimmt gerade etwas Neues an."
                ) : project.autopilot ? (
                  "Niemand arbeitet gerade. Der nächste Schritt kommt automatisch."
                ) : (
                  "Autopilot ist aus – das Team wartet auf den nächsten Anstoß."
                )}
              </p>

              <ActionForm action={setAutopilot}>
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="autopilot" value={project.autopilot ? "off" : "on"} />
                <button type="submit" className={buttonSecondaryClass}>
                  {project.autopilot ? "Autopilot ausschalten" : "Autopilot einschalten"}
                </button>
              </ActionForm>

              {project.status === "ACTIVE" ? (
                <>
                  <ActionForm action={nudgeTeam}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <button type="submit" className={buttonPrimaryClass}>
                      Nächsten Schritt anstoßen
                    </button>
                  </ActionForm>
                  <ActionForm action={pauseTeam}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <ConfirmButton
                      confirmText="Arbeit anhalten? Der laufende Schritt wird noch beendet."
                      className={buttonDangerClass}
                    >
                      Anhalten
                    </ConfirmButton>
                  </ActionForm>
                </>
              ) : (
                <ActionForm action={resumeTeam}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <button type="submit" className={buttonPrimaryClass}>
                    Arbeit fortsetzen
                  </button>
                </ActionForm>
              )}
            </div>
          </Section>

          <Section title="Wer gerade woran arbeitet">
            {project.agents.length === 0 ? (
              <EmptyHint>Diesem Projekt ist noch niemand zugeordnet.</EmptyHint>
            ) : (
              <ul className="grid gap-2 md:grid-cols-2">
                {project.agents.map(({ agent }) => {
                  const running = runningByAgent.get(agent.id);
                  const last = lastRunByAgent.get(agent.id);
                  return (
                    <li key={agent.id} className="card p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium text-ink">{agent.name}</span>
                        <span className={`${AGENT_STATUS_PILL[agent.status]} pill-dot shrink-0`}>
                          {AGENT_STATUS_LABEL[agent.status]}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-3">{AGENT_ROLE_LABEL[agent.role]}</p>
                      <p className="mt-2 text-sm text-ink-2">
                        {running ? (
                          running.headline
                        ) : last ? (
                          <span className="text-ink-3">
                            zuletzt: {last.headline}{" "}
                            <span className="text-ink-4">· {formatTime(last.startedAt)}</span>
                          </span>
                        ) : (
                          <span className="text-ink-4">noch nichts getan</span>
                        )}
                      </p>
                      {running && (
                        <p className="mt-1 text-xs text-ink-4">
                          {RUN_KIND_LABEL[running.kind] ?? running.kind} · seit {formatTime(running.startedAt)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Aktueller Sprint"
            action={
              sprint && (
                <span className={SPRINT_STATUS_PILL[sprint.status]}>{SPRINT_STATUS_LABEL[sprint.status]}</span>
              )
            }
          >
            {!sprint ? (
              <EmptyHint>Noch kein Sprint geplant – der Product Owner ist dran.</EmptyHint>
            ) : (
              <div className="card p-5">
                <p className="text-xs text-ink-3">Sprint {sprint.number}</p>
                <p className="mt-1 text-sm font-medium text-ink">{sprint.goal}</p>

                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-good transition-all"
                    style={{ width: `${totalTickets === 0 ? 0 : (doneTickets / totalTickets) * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-ink-3">
                  {doneTickets} von {totalTickets} Tickets fertig
                </p>

                <ul className="mt-4 divide-y divide-hairline border-t border-hairline">
                  {sprint.tickets.map((ticket) => (
                    <li key={ticket.id} className="flex items-start gap-3 py-2.5 text-sm">
                      <span className="mt-0.5 w-24 shrink-0 text-xs text-ink-3">
                        {TICKET_STATUS_LABEL[ticket.status]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-ink">{ticket.title}</span>
                        {ticket.isCritical && (
                          <span className="ml-2 pill pill-critical">kritisch</span>
                        )}
                        {ticket.result && <span className="mt-1 block text-xs text-ink-3">{ticket.result}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-ink-3">
                        {ticket.assignee?.name ?? "—"} · {PRIORITY_LABEL[ticket.priority]}
                      </span>
                    </li>
                  ))}
                </ul>

                {sprint.summary && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm text-accent">Sprint-Review lesen</summary>
                    <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                      {sprint.summary}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </Section>

          {pendingReviews.length > 0 && (
            <Section title="Wartet auf deine Freigabe">
              <ul className="space-y-2">
                {pendingReviews.map((review) => (
                  <li key={review.id} className="card p-5">
                    <p className="text-sm font-medium text-ink">{review.ticket.title}</p>
                    {review.comment && <p className="mt-1 text-sm text-ink-2">{review.comment}</p>}
                    <ActionForm action={decideReview} className="mt-3 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="reviewId" value={review.id} />
                      <input
                        type="text"
                        name="comment"
                        placeholder="Anmerkung (bei Rückweisung die Begründung)"
                        className={`${inputClass} min-w-60 flex-1`}
                      />
                      <button type="submit" name="decision" value="APPROVED" className={buttonPrimaryClass}>
                        Freigeben
                      </button>
                      <button type="submit" name="decision" value="REJECTED" className={buttonDangerClass}>
                        Zurückweisen
                      </button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Rückfrage ans Team">
            <div className="card p-5">
              <ActionForm action={askTeam} className="flex flex-col gap-3">
                <input type="hidden" name="projectId" value={project.id} />
                <textarea
                  name="question"
                  rows={3}
                  required
                  placeholder="z.B. „Wie ist der Stand?“, „Warum habt ihr die Rechnungsprüfung so gebaut?“, „Was blockiert euch?“"
                  className={inputClass}
                />
                <button type="submit" className={`${buttonPrimaryClass} self-start`}>
                  Fragen
                </button>
              </ActionForm>

              {inquiries.length > 0 && (
                <ul className="mt-5 space-y-4 border-t border-hairline pt-5">
                  {inquiries.map((inquiry) => (
                    <li key={inquiry.id}>
                      <p className="text-sm font-medium text-ink">{inquiry.question}</p>
                      <p className="mt-0.5 text-xs text-ink-4">
                        {formatTime(inquiry.createdAt)}
                        {inquiry.answeredBy ? ` · Antwort von ${inquiry.answeredBy.name}` : ""}
                      </p>
                      {inquiry.answer ? (
                        <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                          {inquiry.answer}
                        </pre>
                      ) : (
                        <p className="mt-2 text-sm text-ink-3">
                          {INQUIRY_STATUS_LABEL[inquiry.status]} …
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          <Section
            title="Protokoll"
            className="mb-0"
            action={
              <Link href={`/projects/${project.id}/records`} className="quiet-link text-xs font-medium">
                Alle Nachweise
              </Link>
            }
          >
            {activity.length === 0 ? (
              <EmptyHint>Noch nichts passiert.</EmptyHint>
            ) : (
              <ul className="card divide-y divide-hairline">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex gap-3 px-5 py-2.5 text-sm">
                    <span className="w-28 shrink-0 text-xs text-ink-4">{formatTime(entry.createdAt)}</span>
                    <span className="w-36 shrink-0 truncate text-xs text-ink-3">{entry.actor}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-2">
                        {ACTIVITY_ACTION_LABEL[entry.action] ?? entry.action}
                      </span>
                      {entry.detail && <span className="block text-xs text-ink-3">{entry.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
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
