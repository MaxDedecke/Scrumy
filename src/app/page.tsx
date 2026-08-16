import Link from "next/link";
import { prisma } from "@/lib/prisma";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      projects: {
        orderBy: { createdAt: "asc" },
        include: {
          _count: { select: { tickets: true } },
          tickets: {
            where: { status: { not: "DONE" } },
            select: { id: true, isCritical: true },
          },
        },
      },
      _count: { select: { supportRequests: { where: { status: { not: "CLOSED" } } } } },
    },
  });

  return (
    <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-12">
      <header className="mb-10">
        <p className="text-sm uppercase tracking-wider text-neutral-500">Scrumy</p>
        <h1 className="mt-1 text-3xl font-semibold">Kunden &amp; Projekte</h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          Für jeden Kunden läuft ein virtuelles Scrum-Team aus LLM-Agenten, das dessen
          Individualsoftware baut und wartet – mit menschlichem Review bei kritischen
          Änderungen.
        </p>
      </header>

      {organizations.length === 0 ? (
        <p className="text-neutral-500">
          Noch keine Kunden angelegt. Mit <code className="text-neutral-300">npm run db:seed</code>{" "}
          Demodaten erzeugen.
        </p>
      ) : (
        <div className="space-y-8">
          {organizations.map((org) => (
            <section key={org.id} className="rounded-lg border border-neutral-800 p-6">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-xl font-medium">{org.name}</h2>
                <div className="flex items-center gap-3 text-sm text-neutral-500">
                  {org.industry && <span>{org.industry}</span>}
                  <Link
                    href={`/organizations/${org.id}/inbox`}
                    className="flex items-center gap-1.5 hover:text-neutral-300"
                  >
                    Support-Postfach
                    {org._count.supportRequests > 0 && (
                      <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-200">
                        {org._count.supportRequests}
                      </span>
                    )}
                    <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>

              <ul className="mt-4 space-y-2">
                {org.projects.map((project) => {
                  const openCritical = project.tickets.filter((t) => t.isCritical).length;
                  return (
                    <li key={project.id}>
                      <Link
                        href={`/projects/${project.id}`}
                        className="flex items-center justify-between rounded-md border border-neutral-800 px-4 py-3 hover:border-neutral-600 hover:bg-neutral-900 transition-colors"
                      >
                        <div>
                          <p className="font-medium">{project.name}</p>
                          {project.description && (
                            <p className="mt-0.5 text-sm text-neutral-500">
                              {project.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm text-neutral-400">
                          {openCritical > 0 && (
                            <span className="rounded-full bg-red-900 px-2.5 py-0.5 text-red-200">
                              {openCritical} kritisch offen
                            </span>
                          )}
                          <span>{project.tickets.length} offen</span>
                          <span aria-hidden>→</span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
