"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { EllipsisIcon } from "@/components/icons";

type SidebarProject = { id: string; name: string };
type SidebarOrganization = { id: string; name: string; projects: SidebarProject[] };

// Primäransicht der Sidebar ist die Projektliste (nach Kunde gruppiert). Die
// volle Kundenverwaltung (anlegen/bearbeiten/löschen, s. Startseite) hängt
// bewusst nicht als eigener Umschalter daneben, sondern liegt hinter dem
// "…"-Menü ("Alle Kunden ansehen"), um die Sidebar auf die tägliche Arbeit
// (an welchem Projekt-Board arbeite ich) zu fokussieren.
export function Sidebar({ organizations }: { organizations: SidebarOrganization[] }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-900">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Projekte
        </span>
        <details className="relative">
          <summary
            className="flex cursor-pointer list-none items-center rounded-md p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
            aria-label="Mehr Optionen"
          >
            <EllipsisIcon className="h-5 w-5" />
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
            <Link
              href="/"
              className="block rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
            >
              Alle Kunden ansehen
            </Link>
          </div>
        </details>
      </div>

      <nav className="flex-1 space-y-4 px-2 pb-4">
        {organizations.map((org) => (
          <div key={org.id}>
            <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-neutral-600">
              {org.name}
            </p>
            <div className="space-y-0.5">
              {org.projects.map((project) => {
                const active = pathname?.startsWith(`/projects/${project.id}`);
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className={`block truncate rounded-md px-2 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-sky-950 text-sky-200"
                        : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                    }`}
                  >
                    {project.name}
                  </Link>
                );
              })}
              {org.projects.length === 0 && (
                <p className="px-2 py-1 text-xs text-neutral-700">Keine Projekte</p>
              )}
            </div>
          </div>
        ))}
        {organizations.length === 0 && (
          <p className="px-2 text-sm text-neutral-600">Noch keine Kunden angelegt.</p>
        )}
      </nav>
    </aside>
  );
}
