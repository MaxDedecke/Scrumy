import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  AGENT_ROLE_LABEL,
  CONNECTOR_PROVIDER_LABEL,
  CONNECTOR_STATUS_COLOR,
  SUPPORT_CHANNEL_LABEL,
  SUPPORT_REQUEST_STATUS_COLOR,
  SUPPORT_REQUEST_STATUS_LABEL,
} from "@/lib/labels";

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
    <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Kunden &amp; Projekte
        </Link>
        <p className="mt-2 text-sm uppercase tracking-wider text-neutral-500">
          {organization.name}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Support-Postfach</h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          Kundenkorrespondenz (Feature-Requests, Bugs, allgemeine Anfragen) – triagiert
          vom Support-Agenten, vom Product-Owner-Agenten in Tickets überführt.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Connectoren
        </h2>
        {organization.connectors.length === 0 ? (
          <p className="text-sm text-neutral-600">
            Kein Connector eingerichtet – Anfragen müssen manuell erfasst werden.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {organization.connectors.map((connector) => (
              <div
                key={connector.id}
                className="flex items-center gap-2 rounded-md border border-neutral-800 px-3 py-1.5"
              >
                <span className="text-sm font-medium">{connector.name}</span>
                <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  {CONNECTOR_PROVIDER_LABEL[connector.provider]}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${CONNECTOR_STATUS_COLOR[connector.status]}`}
                >
                  {connector.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Anfragen
        </h2>
        <div className="space-y-3">
          {organization.supportRequests.map((request) => (
            <article key={request.id} className="rounded-lg border border-neutral-800 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{request.subject ?? "(kein Betreff)"}</p>
                  <p className="mt-1 text-sm text-neutral-500">{request.body}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${SUPPORT_REQUEST_STATUS_COLOR[request.status]}`}
                >
                  {SUPPORT_REQUEST_STATUS_LABEL[request.status]}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                  {SUPPORT_CHANNEL_LABEL[request.channel]}
                </span>
                {request.externalRef && (
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5">{request.externalRef}</span>
                )}
                {request.fromContact && <span>von {request.fromContact}</span>}
                {request.handledBy && (
                  <span>
                    · triagiert von {request.handledBy.name} (
                    {AGENT_ROLE_LABEL[request.handledBy.role]})
                  </span>
                )}
                <span>· {request.createdAt.toLocaleString("de-DE")}</span>
              </div>

              {request.tickets.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-neutral-900 pt-3">
                  {request.tickets.map((ticket) => (
                    <Link
                      key={ticket.id}
                      href={`/projects/${ticket.projectId}`}
                      className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-600 hover:bg-neutral-900"
                    >
                      → Ticket: {ticket.title}
                    </Link>
                  ))}
                </div>
              )}
            </article>
          ))}
          {organization.supportRequests.length === 0 && (
            <p className="text-sm text-neutral-600">Noch keine Kundenanfragen.</p>
          )}
        </div>
      </section>
    </main>
  );
}
