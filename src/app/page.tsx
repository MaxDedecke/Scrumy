import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { createOrganization, deleteOrganization, updateOrganization } from "@/lib/actions/organizations";
import { createProject } from "@/lib/actions/projects";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { EmptyHint } from "@/components/Section";
import { ArrowRightIcon, InboxIcon } from "@/components/icons";
import { buttonDangerClass, buttonPrimaryClass, buttonSecondaryClass, inputClass, labelClass, pageClass } from "@/lib/ui";

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
    <main className={pageClass}>
      <PageHeader
        context="Übersicht"
        title="Kunden & Projekte"
        description="Für jeden Kunden läuft ein virtuelles Scrum-Team aus LLM-Agenten, das dessen Individualsoftware baut und wartet – mit menschlichem Review bei kritischen Änderungen."
      />

      <Disclosure label="Neuer Kunde" className="mb-8">
        <form action={createOrganization} className={formGridClass}>
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
      </Disclosure>

      {organizations.length === 0 ? (
        <EmptyHint>Noch keine Kunden angelegt.</EmptyHint>
      ) : (
        <div className="space-y-5">
          {organizations.map((org) => (
            <section key={org.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-ink">{org.name}</h2>
                  <p className="mt-0.5 text-sm text-ink-3">
                    {org.industry ?? "Keine Branche hinterlegt"} · {org.projects.length} Projekt
                    {org.projects.length === 1 ? "" : "e"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  <Link
                    href={`/organizations/${org.id}/inbox`}
                    className="inline-flex items-center gap-2 rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <InboxIcon className="h-4 w-4" />
                    Support-Postfach
                    {org._count.supportRequests > 0 && (
                      <span className="pill pill-info">{org._count.supportRequests}</span>
                    )}
                  </Link>
                  <details className="relative">
                    <summary className="cursor-pointer list-none rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
                      Bearbeiten
                    </summary>
                    <div className="absolute right-0 z-10 mt-2 w-72 rounded-xl border border-hairline bg-surface p-4 shadow-2xl shadow-black/50">
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
                        <button type="submit" className={`${buttonPrimaryClass} w-full`}>
                          Speichern
                        </button>
                      </form>
                      <form action={deleteOrganization} className="mt-4 border-t border-hairline pt-4">
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

              {org.projects.length > 0 && (
                <ul className="mt-5 space-y-2">
                  {org.projects.map((project) => {
                    const openCritical = project.tickets.filter((t) => t.isCritical).length;
                    return (
                      <li key={project.id}>
                        <Link
                          href={`/projects/${project.id}`}
                          className="card-interactive group flex items-center justify-between gap-4 bg-surface-2 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink">{project.name}</p>
                            {project.description && (
                              <p className="mt-0.5 truncate text-sm text-ink-3">{project.description}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-3 text-sm text-ink-3">
                            {openCritical > 0 && (
                              <span className="pill pill-critical pill-dot">{openCritical} kritisch</span>
                            )}
                            <span>{project.tickets.length} offen</span>
                            <ArrowRightIcon className="h-4 w-4 text-ink-4 transition-colors group-hover:text-ink-2" />
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}

              <Disclosure label={`Neues Projekt für ${org.name}`} className="mt-4 bg-transparent">
                <form action={createProject} className={formGridClass}>
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
              </Disclosure>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
