import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_PILL,
  PRIORITY_LABEL,
  PRIORITY_PILL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_PILL,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_ORDER,
  TICKET_TYPE_LABEL,
} from "@/lib/labels";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { ExternalLinkIcon, InboxIcon, WarningIcon } from "@/components/icons";
import { deleteProject, updateProject } from "@/lib/actions/projects";
import { buttonDangerClass, buttonPrimaryClass, inputClass, labelClass, pageClass } from "@/lib/ui";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      organization: true,
      tickets: {
        orderBy: { updatedAt: "desc" },
        include: { reviews: true },
      },
      agents: { include: { agent: true, connector: true } },
    },
  });

  if (!project) notFound();

  const activity = await prisma.activityLogEntry.findMany({
    where: { OR: [{ projectId }, { ticket: { projectId } }] },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { ticket: true, supportRequest: true },
  });

  const ticketsByStatus = TICKET_STATUS_ORDER.map((status) => ({
    status,
    tickets: project.tickets.filter((t) => t.status === status),
  }));

  const openTickets = project.tickets.filter((t) => t.status !== "DONE");
  const criticalOpen = openTickets.filter((t) => t.isCritical).length;
  const pendingReviews = project.tickets.reduce(
    (sum, t) => sum + t.reviews.filter((r) => r.decision === "PENDING").length,
    0,
  );

  // Kennzahlen-Kacheln: ein Zustand pro Kachel, kein Diagramm. Der Farbton
  // kommt aus der festen Statuspalette und steht nie allein – Label und Punkt
  // tragen die Bedeutung mit.
  const stats: { label: string; value: number; tone?: "critical" | "warning" }[] = [
    { label: "Offene Tickets", value: openTickets.length },
    { label: "In Review", value: ticketsByStatus.find((c) => c.status === "IN_REVIEW")?.tickets.length ?? 0 },
    { label: "Kritisch offen", value: criticalOpen, tone: criticalOpen > 0 ? "critical" : undefined },
    { label: "Reviews ausstehend", value: pendingReviews, tone: pendingReviews > 0 ? "warning" : undefined },
  ];

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
        actions={
          <>
            <Link
              href={`/organizations/${project.organizationId}/inbox`}
              className="quiet-link inline-flex items-center gap-1.5"
            >
              <InboxIcon className="h-4 w-4" />
              Support-Postfach
            </Link>
            {project.repoUrl && (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="quiet-link inline-flex items-center gap-1.5"
              >
                <ExternalLinkIcon className="h-4 w-4" />
                Repository
              </a>
            )}
          </>
        }
      />

      <ProjectTabs projectId={project.id} active="overview" />

      {(project.status === "DISCOVERY" || project.status === "CONCEPT") && (
        <p className="mb-8 rounded-xl border border-accent-border bg-accent-soft px-4 py-3 text-sm text-accent">
          Team ist noch nicht gestartet – Projekt ist in der{" "}
          {project.status === "DISCOVERY" ? "Discovery-Phase" : "Konzeptphase"}.{" "}
          <Link href={`/projects/${project.id}/discovery`} className="font-medium underline underline-offset-2 hover:text-ink">
            Anforderungen &amp; Konzept bearbeiten
          </Link>
          , um das Team zu starten.
        </p>
      )}

      <section className="mb-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="card p-4">
            <p
              className={`text-3xl font-semibold ${
                stat.tone === "critical"
                  ? "text-critical"
                  : stat.tone === "warning"
                    ? "text-warning"
                    : "text-ink"
              }`}
            >
              {stat.value}
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-3">
              {stat.tone && (
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${
                    stat.tone === "critical" ? "bg-critical" : "bg-warning"
                  }`}
                />
              )}
              {stat.label}
            </p>
          </div>
        ))}
      </section>

      <Section
        title="Agenten-Team"
        action={
          <Link href={`/projects/${project.id}/team`} className="quiet-link text-xs font-medium">
            Konfigurieren →
          </Link>
        }
      >
        {project.agents.length === 0 ? (
          <EmptyHint>
            Noch kein Agenten-Team –{" "}
            <Link href={`/projects/${project.id}/team`} className="text-accent underline underline-offset-2">
              jetzt einrichten
            </Link>
            .
          </EmptyHint>
        ) : (
          <div className="flex flex-wrap gap-2">
            {project.agents.map(({ agent, connector }) => (
              <div key={agent.id} className="card flex items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium text-ink">{agent.name}</span>
                <span className="pill pill-neutral">{AGENT_ROLE_LABEL[agent.role]}</span>
                <span className={`${AGENT_STATUS_PILL[agent.status]} pill-dot`}>
                  {AGENT_STATUS_LABEL[agent.status]}
                </span>
                {connector && <span className="text-xs text-ink-4">via {connector.name}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Scrum-Board">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ticketsByStatus.map(({ status, tickets }) => (
            <div key={status} className="card flex flex-col">
              <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
                <h3 className="text-sm font-medium text-ink">{TICKET_STATUS_LABEL[status]}</h3>
                <span className="text-xs tabular-nums text-ink-3">{tickets.length}</span>
              </div>
              <div className="space-y-2 p-2">
                {tickets.length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-ink-4">Keine Tickets</p>
                )}
                {tickets.map((ticket) => {
                  const pendingReview = ticket.reviews.find((r) => r.decision === "PENDING");
                  return (
                    <article key={ticket.id} className="card-interactive bg-surface-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-snug text-ink">{ticket.title}</p>
                        {ticket.isCritical && (
                          <span
                            title="Kritische Änderung – benötigt menschliches Review"
                            className="shrink-0 text-warning"
                          >
                            <WarningIcon className="h-4 w-4" />
                            <span className="sr-only">Kritische Änderung</span>
                          </span>
                        )}
                      </div>
                      {ticket.description && (
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-3">
                          {ticket.description}
                        </p>
                      )}
                      {ticket.plan && (
                        <p className="mt-2 rounded-lg border border-hairline bg-canvas p-2 text-[11px] leading-relaxed text-ink-2">
                          <span className="font-medium text-ink">Plan: </span>
                          {ticket.plan}
                        </p>
                      )}
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <span className="pill pill-neutral">{TICKET_TYPE_LABEL[ticket.type]}</span>
                        <span className={PRIORITY_PILL[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</span>
                        {pendingReview && <span className="pill pill-warning pill-dot">Review offen</span>}
                        {ticket.externalRef && <span className="pill pill-neutral">{ticket.externalRef}</span>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Aktivität">
        {activity.length === 0 ? (
          <EmptyHint>Noch keine Aktivität.</EmptyHint>
        ) : (
          <ul className="card divide-y divide-hairline">
            {activity.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="shrink-0 tabular-nums text-xs text-ink-4">
                  {entry.createdAt.toLocaleString("de-DE")}
                </span>
                <span className="shrink-0 font-medium text-ink">{entry.actor}</span>
                <span className="text-ink-3">
                  → {entry.ticket?.title ?? entry.supportRequest?.subject ?? "Projekt"}:
                </span>
                <span className="text-ink-2">{entry.detail ?? entry.action}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Projekt-Einstellungen" className="mb-0">
        <div className="card p-5">
          <form action={updateProject} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="id" value={project.id} />
            <div>
              <label className={labelClass}>Name</label>
              <input name="name" defaultValue={project.name} required className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <select name="status" defaultValue={project.status} className={inputClass}>
                <option value="DISCOVERY">{PROJECT_STATUS_LABEL.DISCOVERY}</option>
                <option value="CONCEPT">{PROJECT_STATUS_LABEL.CONCEPT}</option>
                <option value="ACTIVE">{PROJECT_STATUS_LABEL.ACTIVE}</option>
                <option value="PAUSED">{PROJECT_STATUS_LABEL.PAUSED}</option>
                <option value="ARCHIVED">{PROJECT_STATUS_LABEL.ARCHIVED}</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Repository-URL</label>
              <input name="repoUrl" defaultValue={project.repoUrl ?? ""} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Beschreibung</label>
              <input name="description" defaultValue={project.description ?? ""} className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonPrimaryClass}>
                Speichern
              </button>
            </div>
          </form>
          <form action={deleteProject} className="mt-5 border-t border-hairline pt-5">
            <input type="hidden" name="id" value={project.id} />
            <ConfirmButton
              confirmText={`Projekt "${project.name}" inkl. aller Tickets und Agenten-Einsätze wirklich löschen?`}
              className={buttonDangerClass}
            >
              Projekt löschen
            </ConfirmButton>
          </form>
        </div>
      </Section>
    </main>
  );
}
