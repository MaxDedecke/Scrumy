import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  CONNECTOR_PROVIDER_LABEL,
  CONNECTOR_STATUS_LABEL,
  CONNECTOR_STATUS_PILL,
  SUPPORT_CHANNEL_LABEL,
  SUPPORT_REQUEST_STATUS_LABEL,
  SUPPORT_REQUEST_STATUS_PILL,
} from "@/lib/labels";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { pageClass } from "@/lib/ui";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function SupportInboxPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      connectors: { orderBy: { createdAt: "asc" } },
      supportRequests: {
        orderBy: { createdAt: "desc" },
        include: {
          connector: true,
          handledBy: true,
          tickets: { include: { project: true } },
        },
      },
    },
  });

  if (!organization) notFound();

  return (
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context={organization.name}
        title="Support-Postfach"
        description="Kundenkorrespondenz (Feature-Requests, Bugs, allgemeine Anfragen) – triagiert vom Support-Agenten, vom Product-Owner-Agenten in Tickets überführt."
      />

      <Section title="Connectoren">
        {organization.connectors.length === 0 ? (
          <EmptyHint>Kein Connector eingerichtet – Anfragen müssen manuell erfasst werden.</EmptyHint>
        ) : (
          <div className="flex flex-wrap gap-2">
            {organization.connectors.map((connector) => (
              <div key={connector.id} className="card flex items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium text-ink">{connector.name}</span>
                <span className="pill pill-neutral">{CONNECTOR_PROVIDER_LABEL[connector.provider]}</span>
                <span className={`${CONNECTOR_STATUS_PILL[connector.status]} pill-dot`}>
                  {CONNECTOR_STATUS_LABEL[connector.status]}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Anfragen" className="mb-0">
        <div className="space-y-2">
          {organization.supportRequests.map((request) => (
            <article key={request.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{request.subject ?? "(kein Betreff)"}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-2">{request.body}</p>
                </div>
                <span className={`shrink-0 ${SUPPORT_REQUEST_STATUS_PILL[request.status]} pill-dot`}>
                  {SUPPORT_REQUEST_STATUS_LABEL[request.status]}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-ink-3">
                <span className="pill pill-neutral">{SUPPORT_CHANNEL_LABEL[request.channel]}</span>
                {request.externalRef && <span className="pill pill-neutral">{request.externalRef}</span>}
                {request.fromContact && <span>von {request.fromContact}</span>}
                {request.handledBy && (
                  <span>
                    · triagiert von {request.handledBy.name} ({AGENT_ROLE_LABEL[request.handledBy.role]})
                  </span>
                )}
                <span className="tabular-nums">· {request.createdAt.toLocaleString("de-DE")}</span>
              </div>

              {request.tickets.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-hairline pt-3">
                  {request.tickets.map((ticket) => (
                    <Link
                      key={ticket.id}
                      href={`/projects/${ticket.projectId}`}
                      className="rounded-lg border border-hairline bg-surface-2 px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-hairline-strong hover:text-ink"
                    >
                      Ticket: {ticket.title} →
                    </Link>
                  ))}
                </div>
              )}
            </article>
          ))}
          {organization.supportRequests.length === 0 && <EmptyHint>Noch keine Kundenanfragen.</EmptyHint>}
        </div>
      </Section>
    </main>
  );
}
