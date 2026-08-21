import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_PILL,
  SPRINT_STATUS_LABEL,
  TICKET_STATUS_ORDER,
} from "@/lib/labels";
import { Panel, PanelEmpty, PanelGrid, PanelStrip } from "@/components/Panel";
import { WarningIcon } from "@/components/icons";
import { TicketBoardPanel } from "@/components/TicketBoardPanel";
import { backendGatedTicketIds } from "@/lib/ticketGate";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function ProjectBoardPage({
  params,
}: PageProps<"/projects/[projectId]/board">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      tickets: {
        orderBy: { updatedAt: "desc" },
        include: {
          reviews: true,
          assignee: { select: { id: true, name: true } },
          sprint: { select: { number: true } },
          blockedBy: { select: { id: true, title: true, status: true } },
        },
      },
      agents: { include: { agent: true, connector: true } },
    },
  });

  if (!project) notFound();

  const [sprint, openClarifications, activity] = await Promise.all([
    prisma.sprint.findFirst({ where: { projectId }, orderBy: { number: "desc" }, include: { tickets: true } }),
    prisma.clarification.findMany({ where: { projectId, status: "OPEN" }, orderBy: { createdAt: "asc" } }),
    prisma.activityLogEntry.findMany({
      where: { OR: [{ projectId }, { ticket: { projectId } }] },
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { ticket: true, supportRequest: true },
    }),
  ]);

  // Frontend-Tickets, die wegen unfertiger Backend-Vorarbeit im Sprint noch
  // nicht gezogen werden (siehe worker/clarification.ts#backendGatedTicketIds)
  // – sonst sieht das Board ein liegen gebliebenes Frontend-Ticket ohne
  // erkennbaren Grund, weil dafür (anders als bei `dependsOn`) keine
  // explizite `Ticket.blockedBy`-Verknüpfung existiert.
  const backendGated = new Set(sprint ? await backendGatedTicketIds(sprint.id) : []);

  const ticketsByStatus = TICKET_STATUS_ORDER.map((status) => ({
    status,
    tickets: project.tickets
      .filter((t) => t.status === status)
      .map((t) => ({ ...t, backendGated: backendGated.has(t.id) })),
  }));

  const openTickets = project.tickets.filter((t) => t.status !== "DONE");
  const criticalOpen = openTickets.filter((t) => t.isCritical).length;
  const pendingReviews = project.tickets.reduce(
    (sum, t) => sum + t.reviews.filter((r) => r.decision === "PENDING").length,
    0,
  );

  // Kennzahlen: ein Zustand pro Kachel, kein Diagramm. Der Farbton kommt aus
  // der festen Statuspalette und steht nie allein – Label und Punkt tragen die
  // Bedeutung mit.
  const stats: { label: string; value: number; tone?: "critical" | "warning" }[] = [
    { label: "Offene Tickets", value: openTickets.length },
    { label: "In Review", value: ticketsByStatus.find((c) => c.status === "IN_REVIEW")?.tickets.length ?? 0 },
    { label: "Kritisch offen", value: criticalOpen, tone: criticalOpen > 0 ? "critical" : undefined },
    { label: "Reviews ausstehend", value: pendingReviews, tone: pendingReviews > 0 ? "warning" : undefined },
  ];

  return (
    <>
      {(project.status === "DISCOVERY" || project.status === "CONCEPT") && (
        <PanelStrip>
          <p className="rounded-xl border border-accent-border bg-accent-soft px-4 py-2.5 text-sm text-accent">
            Team ist noch nicht gestartet – Projekt ist in der{" "}
            {project.status === "DISCOVERY" ? "Discovery-Phase" : "Konzeptphase"}.{" "}
            <Link
              href={`/projects/${project.id}/discovery`}
              className="font-medium underline underline-offset-2 hover:text-ink"
            >
              Anforderungen &amp; Konzept bearbeiten
            </Link>
            , um das Team zu starten.
          </p>
        </PanelStrip>
      )}

      {openClarifications.length > 0 && (
        <PanelStrip>
          <Link
            href={`/projects/${project.id}`}
            className="flex items-start gap-2.5 rounded-xl border border-critical/35 bg-critical/10 px-4 py-2.5 text-sm text-ink transition-colors hover:border-critical/60"
          >
            <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-critical" />
            <span className="min-w-0">
              <span className="font-medium">
                {openClarifications.length === 1
                  ? "Das Team braucht eine Entscheidung"
                  : `Das Team braucht ${openClarifications.length} Entscheidungen`}
                :
              </span>{" "}
              {openClarifications[0].question}
              {openClarifications.some((entry) => entry.scope === "PROJECT")
                ? " – bis dahin arbeitet niemand weiter."
                : " – die betroffenen Tickets liegen so lange."}
            </span>
          </Link>
        </PanelStrip>
      )}

      <PanelStrip>
        <div className="card grid grid-cols-2 divide-hairline sm:grid-cols-4 sm:divide-x">
          {stats.map((stat) => (
            <div key={stat.label} className="flex items-baseline gap-2 px-4 py-2.5">
              <span
                className={`text-xl font-semibold tabular-nums ${
                  stat.tone === "critical"
                    ? "text-critical"
                    : stat.tone === "warning"
                      ? "text-warning"
                      : "text-ink"
                }`}
              >
                {stat.value}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-3">
                {stat.tone && (
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      stat.tone === "critical" ? "bg-critical" : "bg-warning"
                    }`}
                  />
                )}
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      </PanelStrip>

      <PanelGrid className="lg:grid-cols-2 lg:grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <TicketBoardPanel
          ticketsByStatus={ticketsByStatus}
          action={
            sprint ? (
              <Link href={`/projects/${project.id}`} className="quiet-link font-medium">
                Sprint {sprint.number} · {SPRINT_STATUS_LABEL[sprint.status]} ·{" "}
                {sprint.tickets.filter((ticket) => ticket.status === "DONE").length}/{sprint.tickets.length}{" "}
                fertig →
              </Link>
            ) : (
              <span className="text-ink-4">noch kein Sprint</span>
            )
          }
        />

        <Panel
          title="Agenten-Team"
          count={project.agents.length}
          padded={false}
          action={
            <Link href={`/projects/${project.id}/team`} className="quiet-link font-medium">
              Konfigurieren →
            </Link>
          }
        >
          {project.agents.length === 0 ? (
            <PanelEmpty>
              Noch kein Agenten-Team –{" "}
              <Link href={`/projects/${project.id}/team`} className="text-accent underline underline-offset-2">
                jetzt einrichten
              </Link>
              .
            </PanelEmpty>
          ) : (
            <ul className="divide-y divide-hairline">
              {project.agents.map(({ agent, connector }) => (
                <li key={agent.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{agent.name}</span>
                    <span className="block truncate text-xs text-ink-3">
                      {AGENT_ROLE_LABEL[agent.role]}
                      {connector ? ` · via ${connector.name}` : ""}
                    </span>
                  </span>
                  <span className={`${AGENT_STATUS_PILL[agent.status]} pill-dot shrink-0`}>
                    {AGENT_STATUS_LABEL[agent.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Aktivität"
          padded={false}
          action={
            <Link href={`/projects/${project.id}/records`} className="quiet-link font-medium">
              Nachweise →
            </Link>
          }
        >
          {activity.length === 0 ? (
            <PanelEmpty>Noch keine Aktivität.</PanelEmpty>
          ) : (
            <ul className="divide-y divide-hairline">
              {activity.map((entry) => (
                <li key={entry.id} className="flex gap-3 px-4 py-2 text-sm">
                  <span className="w-24 shrink-0 tabular-nums text-xs text-ink-4">
                    {formatTime(entry.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-ink-2">
                      <span className="text-ink">{entry.actor}</span> ·{" "}
                      {entry.ticket?.title ?? entry.supportRequest?.subject ?? "Projekt"}
                    </span>
                    <span className="block truncate text-xs text-ink-3">
                      {entry.detail ?? entry.action}
                    </span>
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
