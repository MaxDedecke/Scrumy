import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { createOrganization, deleteOrganization, updateOrganization } from "@/lib/actions/organizations";
import { createProject } from "@/lib/actions/projects";
import { ConfirmButton } from "@/components/ConfirmButton";
import { buttonDangerClass, buttonPrimaryClass, buttonSecondaryClass, inputClass, labelClass } from "@/lib/ui";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      projects: {
        orderBy: { createdAt: "asc" },
        include: {
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
      <header className="mb-10 flex items-start justify-between gap-6">
        <div>
          <p className="text-sm uppercase tracking-wider text-neutral-500">Scrumy</p>
          <h1 className="mt-1 text-3xl font-semibold">Kunden &amp; Projekte</h1>
          <p className="mt-2 max-w-2xl text-neutral-400">
            Für jeden Kunden läuft ein virtuelles Scrum-Team aus LLM-Agenten, das dessen
            Individualsoftware baut und wartet – mit menschlichem Review bei kritischen
            Änderungen.
          </p>
        </div>
      </header>

      <details className="mb-10 rounded-lg border border-neutral-800 open:bg-neutral-950">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-neutral-300">
          + Neuer Kunde
        </summary>
        <form action={createOrganization} className="grid gap-3 border-t border-neutral-900 p-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="org-name">
              Name
            </label>
            <input id="org-name" name="name" required className={inputClass} placeholder="Musterfirma GmbH" />
          </div>
          <div>
            <label className={labelClass} htmlFor="org-industry">
              Branche (optional)
            </label>
            <input id="org-industry" name="industry" className={inputClass} placeholder="z.B. Großhandel" />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimaryClass}>
              Kunde anlegen
            </button>
          </div>
        </form>
      </details>

      {organizations.length === 0 ? (
        <p className="text-neutral-500">Noch keine Kunden angelegt.</p>
      ) : (
        <div className="space-y-8">
          {organizations.map((org) => (
            <section key={org.id} className="rounded-lg border border-neutral-800 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-medium">{org.name}</h2>
                  {org.industry && <p className="text-sm text-neutral-500">{org.industry}</p>}
                </div>
                <div className="flex items-center gap-3 text-sm text-neutral-500">
                  <Link href={`/organizations/${org.id}/inbox`} className="flex items-center gap-1.5 hover:text-neutral-300">
                    Support-Postfach
                    {org._count.supportRequests > 0 && (
                      <span className="rounded-full bg-sky-900 px-2 py-0.5 text-xs text-sky-200">
                        {org._count.supportRequests}
                      </span>
                    )}
                  </Link>
                  <details className="relative">
                    <summary className="cursor-pointer list-none rounded-md border border-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-900">
                      Bearbeiten
                    </summary>
                    <div className="absolute right-0 z-10 mt-2 w-72 rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl">
                      <form action={updateOrganization} className="space-y-3">
                        <input type="hidden" name="id" value={org.id} />
                        <div>
                          <label className={labelClass}>Name</label>
                          <input name="name" defaultValue={org.name} required className={inputClass} />
                        </div>
                        <div>
                          <label className={labelClass}>Branche</label>
                          <input name="industry" defaultValue={org.industry ?? ""} className={inputClass} />
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <button type="submit" className={buttonPrimaryClass}>
                            Speichern
                          </button>
                        </div>
                      </form>
                      <form action={deleteOrganization} className="mt-3 border-t border-neutral-900 pt-3">
                        <input type="hidden" name="id" value={org.id} />
                        <ConfirmButton
                          confirmText={`Kunde "${org.name}" inkl. aller Projekte, Tickets und Anfragen wirklich löschen?`}
                          className={`${buttonDangerClass} w-full`}
                        >
                          Kunde löschen
                        </ConfirmButton>
                      </form>
                    </div>
                  </details>
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
                            <p className="mt-0.5 text-sm text-neutral-500">{project.description}</p>
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

              <details className="mt-4">
                <summary className="cursor-pointer select-none text-sm text-neutral-500 hover:text-neutral-300">
                  + Neues Projekt für {org.name}
                </summary>
                <form action={createProject} className="mt-3 grid gap-3 rounded-md border border-neutral-900 p-4 sm:grid-cols-2">
                  <input type="hidden" name="organizationId" value={org.id} />
                  <div>
                    <label className={labelClass}>Name</label>
                    <input name="name" required className={inputClass} placeholder="z.B. Warenwirtschaft & CRM" />
                  </div>
                  <div>
                    <label className={labelClass}>Repository-URL (optional)</label>
                    <input name="repoUrl" className={inputClass} placeholder="https://github.com/…" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>Beschreibung (optional)</label>
                    <input name="description" className={inputClass} placeholder="Kurzbeschreibung der Software" />
                  </div>
                  <div className="sm:col-span-2">
                    <button type="submit" className={buttonSecondaryClass}>
                      Projekt anlegen
                    </button>
                  </div>
                </form>
              </details>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
