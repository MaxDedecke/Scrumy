import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_STATUS_COLOR,
  AGENT_STATUS_LABEL,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_ORDER,
  TICKET_TYPE_LABEL,
} from "@/lib/labels";

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
      agents: { include: { agent: true } },
    },
  });

  if (!project) notFound();

  const activity = await prisma.activityLogEntry.findMany({
    where: { ticket: { projectId } },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { ticket: true, agent: true },
  });

  const ticketsByStatus = TICKET_STATUS_ORDER.map((status) => ({
    status,
    tickets: project.tickets.filter((t) => t.status === status),
  }));

  return (
    <main className="flex-1 mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-8">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Kunden &amp; Projekte
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wider text-neutral-500">
              {project.organization.name}
            </p>
            <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
          </div>
          {project.repoUrl && (
            <a
              href={project.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-neutral-500 hover:text-neutral-300"
            >
              Repository ↗
            </a>
          )}
        </div>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Agenten-Team
        </h2>
        <div className="flex flex-wrap gap-3">
          {project.agents.map(({ agent }) => (
            <div
              key={agent.id}
              className="flex items-center gap-2 rounded-md border border-neutral-800 px-3 py-1.5"
            >
              <span className="text-sm font-medium">{agent.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${AGENT_STATUS_COLOR[agent.status]}`}
              >
                {AGENT_STATUS_LABEL[agent.status]}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ticketsByStatus.map(({ status, tickets }) => (
          <div key={status} className="rounded-lg border border-neutral-800 bg-neutral-950">
            <div className="border-b border-neutral-800 px-4 py-3">
              <h3 className="text-sm font-medium">
                {TICKET_STATUS_LABEL[status]}{" "}
                <span className="text-neutral-500">({tickets.length})</span>
              </h3>
            </div>
            <div className="space-y-3 p-3">
              {tickets.length === 0 && (
                <p className="px-1 py-2 text-sm text-neutral-600">Keine Tickets</p>
              )}
              {tickets.map((ticket) => {
                const pendingReview = ticket.reviews.find((r) => r.decision === "PENDING");
                return (
                  <article
                    key={ticket.id}
                    className="rounded-md border border-neutral-800 bg-neutral-900 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{ticket.title}</p>
                      {ticket.isCritical && (
                        <span
                          title="Kritische Änderung – benötigt menschliches Review"
                          className="shrink-0 text-amber-400"
                        >
                          ⚠
                        </span>
                      )}
                    </div>
                    {ticket.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-neutral-500">
                        {ticket.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300">
                        {TICKET_TYPE_LABEL[ticket.type]}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] ${PRIORITY_COLOR[ticket.priority]}`}
                      >
                        {PRIORITY_LABEL[ticket.priority]}
                      </span>
                      {pendingReview && (
                        <span className="rounded bg-amber-900 px-1.5 py-0.5 text-[11px] text-amber-200">
                          Review ausstehend
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Aktivität
        </h2>
        <ul className="space-y-2">
          {activity.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline gap-3 rounded-md border border-neutral-900 px-3 py-2 text-sm"
            >
              <span className="shrink-0 text-neutral-600">
                {entry.createdAt.toLocaleString("de-DE")}
              </span>
              <span className="shrink-0 font-medium text-neutral-300">{entry.actor}</span>
              <span className="text-neutral-500">→ {entry.ticket.title}:</span>
              <span className="text-neutral-400">{entry.detail ?? entry.action}</span>
            </li>
          ))}
          {activity.length === 0 && (
            <p className="text-sm text-neutral-600">Noch keine Aktivität.</p>
          )}
        </ul>
      </section>
    </main>
  );
}
