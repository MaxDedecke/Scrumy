import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  ACTIVITY_ACTION_LABEL,
  CLARIFICATION_SCOPE_LABEL,
  CLARIFICATION_SCOPE_PILL,
  CLARIFICATION_TRIGGER_LABEL,
  PRIORITY_LABEL,
  SPRINT_STATUS_LABEL,
  SPRINT_STATUS_PILL,
  TICKET_STATUS_LABEL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { AgentWorkspacePanel } from "@/components/AgentWorkspacePanel";
import { ClarificationChoice } from "@/components/ClarificationChoice";
import { ConfirmButton } from "@/components/ConfirmButton";
import { IconSubmit } from "@/components/IconSubmit";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";
import { TeamChatPanel } from "@/components/TeamChatPanel";
import { ArchiveIcon, ArrowRightIcon, BanIcon, ForwardIcon, SendIcon } from "@/components/icons";
import { decideReview, delegateReview } from "@/lib/actions/team";
import {
  decideClarification,
  forwardClarification,
  withdrawClarification,
} from "@/lib/actions/clarifications";
import { readOptions } from "@/lib/clarificationOptions";
import {
  buttonDangerClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  iconButtonClass,
  iconButtonDangerClass,
  inputClass,
} from "@/lib/ui";

// Der Raum, in den der Auftraggeber geht, wenn er wissen will, was läuft:
// Wer arbeitet gerade woran, wie weit ist der Sprint, was wartet auf ihn – und
// die Möglichkeit, dem Team direkt eine Frage zu stellen.
//
// Raster statt Liste: Die erste Zeile (60% der Höhe) gehört dem Büroplan
// „Wer gerade woran arbeitet" (2/3 Breite) und der Chat-Karte „Rückfragen ans
// Team" (1/3 Breite) daneben. Die zweite Zeile (40%) trägt Sprint, Aktuelle
// Themen und Protokoll zu dritt nebeneinander. Gescrollt wird innerhalb der
// Panels, nicht auf der Seite. Die Steuerung des Teams liegt als Icon-Gruppe
// im Seitenkopf (siehe src/components/TeamControls.tsx), der "Team
// arbeitet"-Zustand als Spinner direkt neben dem Projektnamen (siehe
// layout.tsx) – tab-übergreifend, statt nur hier als Textzeile.
//
// Jedes Panel lässt sich einklappen (Icon neben dem Titel, siehe
// src/components/Panel.tsx); da alle fünf Panels eigene Rasterzellen sind
// statt gestapelter Nachbarn, wirkt sich das Einklappen nur noch auf das
// jeweilige Panel selbst aus.
export const dynamic = "force-dynamic";

// Kompakte Icon-Buttons für die eingeklappte Ansicht von „Aktuelle Themen":
// pro Klärung/Freigabe die möglichen Wege als Ein-Klick-Icons statt der
// vollen Karte mit Agenda, Radio-Auswahl und Textfeld.
const compactIconButtonBase =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors";
const iconButtonCompactGoodClass = `${compactIconButtonBase} text-good hover:bg-good/10`;
const iconButtonCompactCriticalClass = `${compactIconButtonBase} text-critical hover:bg-critical/10`;
const iconButtonCompactClass = `${compactIconButtonBase} text-ink-3 hover:bg-surface-3 hover:text-ink`;

export default async function TeamOfficePage({ params }: PageProps<"/projects/[projectId]/office">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      organization: true,
      agents: { include: { agent: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  const [sprint, runningRuns, lastRuns, activity, pendingReviews, inquiries, clarifications, decisions] =
    await Promise.all([
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
        take: 60,
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
      // Offene Klärungen zuerst und ungekürzt: Sie sind der Grund, warum das
      // Team wartet – alles andere auf dieser Seite ist Beobachtung.
      prisma.clarification.findMany({
        where: { projectId, status: "OPEN" },
        orderBy: { createdAt: "asc" },
        include: { ticket: true, raisedBy: true, forwardedRequest: true },
      }),
      prisma.clarification.findMany({
        where: { projectId, status: { in: ["DECIDED", "WITHDRAWN"] } },
        orderBy: { decidedAt: "desc" },
        take: 20,
        include: { ticket: true },
      }),
    ]);

  const runningByAgent = new Map(runningRuns.map((run) => [run.agentId ?? "", run]));
  const lastRunByAgent = new Map<string, (typeof lastRuns)[number]>();
  for (const run of lastRuns) {
    if (run.agentId && !lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, run);
  }

  const agentEntries = project.agents.map(({ agent }) => {
    const running = runningByAgent.get(agent.id);
    const last = lastRunByAgent.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      running: running ? { headline: running.headline, kind: running.kind, startedAt: running.startedAt } : null,
      last: last ? { headline: last.headline, startedAt: last.startedAt } : null,
    };
  });

  const inquiryEntries = inquiries.map((inquiry) => ({
    id: inquiry.id,
    question: inquiry.question,
    answer: inquiry.answer,
    status: inquiry.status,
    createdAt: inquiry.createdAt,
    answeredByName: inquiry.answeredBy?.name ?? null,
  }));

  const started = project.status === "ACTIVE" || project.status === "PAUSED";
  const doneTickets = sprint?.tickets.filter((ticket) => ticket.status === "DONE").length ?? 0;
  const totalTickets = sprint?.tickets.length ?? 0;
  const waitingCount = clarifications.length + pendingReviews.length;

  if (!started) {
    return (
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
    );
  }

  // Kerninhalt der Sprint-Karte (Nummer, Ziel, Fortschrittsbalken) – im
  // eingeklappten Zustand das Einzige, was von „Aktueller Sprint" stehen
  // bleibt, die Ticketliste fällt weg.
  const sprintSummary = sprint && (
    <>
      <p className="text-xs text-ink-3">Sprint {sprint.number}</p>
      <p className="mt-0.5 text-sm font-medium text-ink">{sprint.goal}</p>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-good transition-all"
          style={{ width: `${totalTickets === 0 ? 0 : (doneTickets / totalTickets) * 100}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-ink-3">
        {doneTickets} von {totalTickets} Tickets fertig
      </p>
    </>
  );

  // Eingeklappte „Aktuelle Themen": pro offenem Punkt der fett gedruckte Titel
  // plus die möglichen Wege als Icon – weitermachen (grün), zurückstellen
  // (Skip-Pfeil) oder anhalten (roter, durchgestrichener Kreis). Ein Klick
  // entscheidet direkt, ohne die Karte erst aufzuklappen.
  const currentTopicsCollapsed = (
    <div className="max-h-64 divide-y divide-hairline overflow-y-auto">
      {clarifications.map((clarification) => {
        const options = readOptions(clarification.options);
        const proceed = options.find((option) => option.effect === "resume" || option.effect === "budget");
        const skip = options.find((option) => option.effect === "skip");
        const stop = options.find((option) => option.effect === "stop");
        return (
          <ActionForm
            key={clarification.id}
            action={decideClarification}
            className="flex items-center gap-2 px-4 py-2"
          >
            <input type="hidden" name="clarificationId" value={clarification.id} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
              {clarification.question}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {proceed && (
                <IconSubmit
                  title={`${proceed.label} – weitermachen`}
                  name="option"
                  value={proceed.key}
                  className={iconButtonCompactGoodClass}
                >
                  <ArrowRightIcon className="h-4 w-4" />
                </IconSubmit>
              )}
              {skip && (
                <IconSubmit
                  title={`${skip.label} – zurückstellen`}
                  name="option"
                  value={skip.key}
                  className={iconButtonCompactClass}
                >
                  <ForwardIcon className="h-4 w-4" />
                </IconSubmit>
              )}
              {stop && (
                <IconSubmit
                  title={`${stop.label} – anhalten`}
                  name="option"
                  value={stop.key}
                  className={iconButtonCompactCriticalClass}
                >
                  <BanIcon className="h-4 w-4" />
                </IconSubmit>
              )}
            </div>
          </ActionForm>
        );
      })}

      {pendingReviews.map((review) => (
        <ActionForm key={review.id} action={decideReview} className="flex items-center gap-2 px-4 py-2">
          <input type="hidden" name="reviewId" value={review.id} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{review.ticket.title}</span>
          <div className="flex shrink-0 items-center gap-1">
            <IconSubmit
              title="Freigeben"
              name="decision"
              value="APPROVED"
              className={iconButtonCompactGoodClass}
            >
              <ArrowRightIcon className="h-4 w-4" />
            </IconSubmit>
            <IconSubmit
              title="Nachbessern"
              name="decision"
              value="REJECTED"
              className={iconButtonCompactCriticalClass}
            >
              <BanIcon className="h-4 w-4" />
            </IconSubmit>
          </div>
        </ActionForm>
      ))}

      {waitingCount === 0 && (
        <p className="px-4 py-3 text-sm text-ink-3">Nichts offen – das Team kommt allein weiter.</p>
      )}
    </div>
  );

  // Eingeklapptes Protokoll: nur der jüngste Eintrag statt der vier, fünf, die
  // sonst in die Kartenhöhe passen.
  const latestActivity = activity[0];
  const activityCollapsed = latestActivity ? (
    <div className="flex gap-3 px-4 py-3 text-sm">
      <span className="w-24 shrink-0 text-xs text-ink-4">{formatTime(latestActivity.createdAt)}</span>
      <span className="w-28 shrink-0 truncate text-xs text-ink-3">{latestActivity.actor}</span>
      <span className="min-w-0 flex-1">
        <span className="text-ink-2">{ACTIVITY_ACTION_LABEL[latestActivity.action] ?? latestActivity.action}</span>
        {latestActivity.detail && (
          <span className="block truncate text-xs text-ink-3">{latestActivity.detail}</span>
        )}
      </span>
    </div>
  ) : (
    <p className="px-4 py-3 text-sm text-ink-3">Noch nichts passiert.</p>
  );

  // Der "arbeitet gerade"-Fall, offene Klärungen und der Autopilot-Zustand
  // haben hier keine eigene Textzeile mehr – sie stehen jetzt klein im
  // Seitenkopf (layout.tsx), tab-übergreifend statt nur im Büro, und nehmen
  // den Karten hier keinen Platz mehr weg.
  return (
    <>
      <PanelGrid className="lg:grid-cols-3 lg:grid-rows-[minmax(0,6fr)_minmax(0,4fr)]">
        <AgentWorkspacePanel className="lg:col-span-2" agents={agentEntries} />

        <TeamChatPanel className="lg:col-span-1" projectId={project.id} inquiries={inquiryEntries} />

        <Panel
          title="Aktueller Sprint"
          padded={false}
          collapsible
          collapsedView={sprint && <div className="px-4 py-3">{sprintSummary}</div>}
          action={
            sprint && (
              <span className={SPRINT_STATUS_PILL[sprint.status]}>{SPRINT_STATUS_LABEL[sprint.status]}</span>
            )
          }
        >
          {!sprint ? (
            <PanelEmpty>Noch kein Sprint geplant – der Product Owner ist dran.</PanelEmpty>
          ) : (
            <>
              <div className="border-b border-hairline px-4 py-3">{sprintSummary}</div>

              <ul className="divide-y divide-hairline">
                {sprint.tickets.map((ticket) => (
                  <li key={ticket.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                    <span className="mt-0.5 w-20 shrink-0 text-xs text-ink-3">
                      {TICKET_STATUS_LABEL[ticket.status]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{ticket.title}</span>
                      {ticket.isCritical && <span className="ml-2 pill pill-critical">kritisch</span>}
                      {ticket.result && <span className="mt-0.5 block text-xs text-ink-3">{ticket.result}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-ink-3">
                      {ticket.assignee?.name ?? "—"} · {PRIORITY_LABEL[ticket.priority]}
                    </span>
                  </li>
                ))}
              </ul>

              {sprint.summary && (
                <details className="border-t border-hairline px-4 py-2.5">
                  <summary className="cursor-pointer text-sm text-accent">Sprint-Review lesen</summary>
                  <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                    {sprint.summary}
                  </pre>
                </details>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Aktuelle Themen"
          count={waitingCount}
          tone={waitingCount > 0 ? "attention" : undefined}
          collapsible
          collapsedView={currentTopicsCollapsed}
        >
          {waitingCount === 0 && decisions.length === 0 ? (
              <PanelEmpty>Nichts offen – das Team kommt allein weiter.</PanelEmpty>
            ) : (
              <div className="space-y-3">
                {clarifications.map((clarification) => {
                  const options = readOptions(clarification.options);
                  return (
                    <article key={clarification.id} className="rounded-lg border border-accent-border p-3.5">
                      <div className="flex items-start gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className={`${CLARIFICATION_SCOPE_PILL[clarification.scope]} pill-dot`}>
                            {CLARIFICATION_SCOPE_LABEL[clarification.scope]}
                          </span>
                          <span className="pill pill-neutral">
                            {CLARIFICATION_TRIGGER_LABEL[clarification.trigger] ?? clarification.trigger}
                          </span>
                          <span className="text-xs text-ink-4">
                            {clarification.raisedBy ? `${clarification.raisedBy.name} · ` : ""}
                            {formatTime(clarification.createdAt)}
                          </span>
                        </div>

                        {/* Nebenwege der Klärung als Icons – der eine Weg, der
                            erklärt werden muss („Beschluss festhalten"), bleibt
                            unten ein beschrifteter Button. */}
                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                          {!clarification.forwardedRequest && (
                            <ActionForm action={forwardClarification}>
                              <input type="hidden" name="clarificationId" value={clarification.id} />
                              <IconSubmit title="An den Kunden weiterleiten" className={iconButtonClass}>
                                <SendIcon className="h-4 w-4" />
                              </IconSubmit>
                            </ActionForm>
                          )}
                          <ActionForm action={withdrawClarification}>
                            <input type="hidden" name="clarificationId" value={clarification.id} />
                            <ConfirmButton
                              confirmText="Klärung zurückziehen? Das Team arbeitet an der Stelle ohne Beschluss weiter."
                              title="Erledigt sich – Klärung zurückziehen"
                              className={iconButtonDangerClass}
                            >
                              <ArchiveIcon className="h-4 w-4" />
                            </ConfirmButton>
                          </ActionForm>
                        </div>
                      </div>

                      <p className="mt-2.5 text-sm font-medium text-ink">{clarification.question}</p>

                      {clarification.agenda ? (
                        <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                          {clarification.agenda}
                        </pre>
                      ) : (
                        <p className="mt-2 text-sm text-ink-3">
                          Der Scrum Master arbeitet noch an einer Entscheidungsvorlage – entscheiden lässt
                          es sich schon jetzt.
                        </p>
                      )}

                      {clarification.context && (
                        <details className="mt-2.5">
                          <summary className="cursor-pointer text-sm text-accent">Was passiert ist</summary>
                          <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                            {clarification.context}
                          </pre>
                        </details>
                      )}

                      {clarification.forwardedRequest && (
                        <p className="mt-2.5 text-xs text-ink-3">
                          Am {formatTime(clarification.forwardedAt ?? clarification.createdAt)} an den Kunden
                          weitergeleitet –{" "}
                          <Link
                            href={`/organizations/${project.organizationId}/inbox`}
                            className="quiet-link font-medium"
                          >
                            im Support-Postfach
                          </Link>
                          .
                        </p>
                      )}

                      <ActionForm action={decideClarification} className="mt-3 flex flex-col gap-2.5">
                        <input type="hidden" name="clarificationId" value={clarification.id} />

                        <ClarificationChoice options={options} recommendedKey={clarification.recommendedOptionKey} />

                        <button type="submit" className={`${buttonPrimaryClass} self-start`}>
                          Beschluss festhalten
                        </button>
                      </ActionForm>
                    </article>
                  );
                })}

                {pendingReviews.map((review) => (
                  <article key={review.id} className="rounded-lg border border-hairline p-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-xs text-ink-3">Freigabe angefragt</p>
                      {/* Empfehlung des Product Owner, wenn er die Freigabe trotzdem
                          vorlegt (siehe reviewTriage): Zustimmen soll ein Klick sein,
                          kein Formulieren – deshalb hier sichtbar und unten im
                          Kommentarfeld vorausgefüllt. */}
                      {review.recommendedDecision && (
                        <span className="pill pill-info">
                          Empfehlung: {review.recommendedDecision === "APPROVED" ? "Freigeben" : "Nachbessern"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-medium text-ink">{review.ticket.title}</p>
                    {review.comment && <p className="mt-1 text-sm text-ink-2">{review.comment}</p>}
                    <ActionForm action={decideReview} className="mt-2.5 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="reviewId" value={review.id} />
                      <input
                        type="text"
                        name="comment"
                        defaultValue={review.recommendedFeedback ?? ""}
                        placeholder="Anmerkung (bei Nachbessern die Begründung)"
                        className={`${inputClass} min-w-48 flex-1`}
                      />
                      <button
                        type="submit"
                        name="decision"
                        value="APPROVED"
                        className={`${buttonPrimaryClass}${review.recommendedDecision === "APPROVED" ? " ring-2 ring-offset-1 ring-offset-surface-1 ring-accent-border" : ""}`}
                      >
                        Freigeben
                      </button>
                      <button
                        type="submit"
                        name="decision"
                        value="REJECTED"
                        className={`${buttonDangerClass}${review.recommendedDecision === "REJECTED" ? " ring-2 ring-offset-1 ring-offset-surface-1 ring-accent-border" : ""}`}
                      >
                        Nachbessern
                      </button>
                    </ActionForm>
                    <ActionForm action={delegateReview} className="mt-1.5">
                      <input type="hidden" name="reviewId" value={review.id} />
                      <button type="submit" className={buttonSecondaryClass}>
                        Team soll entscheiden
                      </button>
                    </ActionForm>
                  </article>
                ))}

                {waitingCount === 0 && (
                  <p className="rounded-lg border border-dashed border-hairline px-4 py-4 text-center text-sm text-ink-3">
                    Nichts offen – das Team kommt allein weiter.
                  </p>
                )}

                {/* Getroffene Beschlüsse bleiben in Reichweite, ohne Platz zu
                    nehmen: Sie sind der Grund, warum dieselbe Frage nicht wieder
                    kommt, und gehören deshalb neben die offenen. */}
                {decisions.length > 0 && (
                  <details className="rounded-lg border border-hairline">
                    <summary className="disclosure-summary px-3.5 py-2.5 text-xs">
                      Beschlussregister ({decisions.length})
                    </summary>
                    <ul className="divide-y divide-hairline border-t border-hairline">
                      {decisions.map((entry) => (
                        <li key={entry.id} className="px-3.5 py-2.5 text-sm">
                          <p className="text-ink-2">{entry.question}</p>
                          <p className="mt-1 text-ink">
                            {entry.status === "WITHDRAWN" ? (
                              <span className="text-ink-3">Zurückgezogen – hat sich erledigt.</span>
                            ) : (
                              entry.decision
                            )}
                          </p>
                          <p className="mt-1 text-xs text-ink-4">
                            {entry.decidedBy ?? "Mensch"} · {formatTime(entry.decidedAt ?? entry.createdAt)}
                            {entry.ticket ? ` · Ticket „${entry.ticket.title}"` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </Panel>

          <Panel
            title="Protokoll"
            padded={false}
            collapsible
            collapsedView={activityCollapsed}
            action={
              <Link href={`/projects/${project.id}/records`} className="quiet-link font-medium">
                Alle Nachweise →
              </Link>
            }
          >
            {activity.length === 0 ? (
              <PanelEmpty>Noch nichts passiert.</PanelEmpty>
            ) : (
              <ul className="divide-y divide-hairline">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex gap-3 px-4 py-2 text-sm">
                    <span className="w-24 shrink-0 text-xs text-ink-4">{formatTime(entry.createdAt)}</span>
                    <span className="w-28 shrink-0 truncate text-xs text-ink-3">{entry.actor}</span>
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
          </Panel>
      </PanelGrid>
    </>
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
