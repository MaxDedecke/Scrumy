"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { ChevronRightIcon, EllipsisIcon, ScrumyMark } from "@/components/icons";
import { useSidebarCollapsed } from "@/lib/sidebarCollapse";

type SidebarProject = { id: string; name: string };
type SidebarOrganization = { id: string; name: string; projects: SidebarProject[] };

// Primäransicht der Sidebar ist die Kundenliste. Ein Kunde wird per Klick
// aufgeklappt (Accordion) und zeigt darunter seine Projekte zur Auswahl – das
// hält die Liste bei vielen Kunden übersichtlich, statt sofort alle Projekte
// aller Kunden untereinander zu listen. Die volle Kundenverwaltung
// (anlegen/bearbeiten/löschen, s. Startseite) hängt bewusst nicht als eigener
// Umschalter daneben, sondern liegt hinter dem "…"-Menü ("Alle Kunden
// ansehen").
export function Sidebar({ organizations }: { organizations: SidebarOrganization[] }) {
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement>(null);

  // Beim Laden den Kunden aufklappen, dessen Projekt gerade aktiv ist, damit
  // man beim Navigieren nicht die Orientierung verliert.
  const [openOrgId, setOpenOrgId] = useState<string | null>(() => {
    const activeOrg = organizations.find((org) =>
      org.projects.some((project) => pathname?.startsWith(`/projects/${project.id}`)),
    );
    return activeOrg?.id ?? null;
  });

  // Ein-/Ausklappen läuft ausschließlich über das "S" in der Header-Leiste
  // (siehe SidebarToggle) – im eingeklappten Zustand ist die Sidebar
  // vollständig unsichtbar statt eines schmalen Icon-Rails, ein eigener
  // Umschalter hier wäre also nie erreichbar.
  const collapsed = useSidebarCollapsed();

  return (
    <aside
      className={`flex shrink-0 flex-col border-r bg-canvas-raised transition-[width,opacity] duration-200 ${
        collapsed ? "w-0 overflow-hidden border-transparent opacity-0" : "w-64 overflow-y-auto border-hairline opacity-100"
      }`}
    >
      {/* Kopfzeile auf exakt der Höhe der Seiten-Kontextzeile, damit Sidebar
          und Inhalt oben auf einer Linie starten. */}
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <span className="section-title pl-1">Kunden</span>
        <details ref={menuRef} className="relative">
          <summary
            className="flex cursor-pointer list-none items-center rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Mehr Optionen"
          >
            <EllipsisIcon className="h-4 w-4" />
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-52 rounded-xl border border-hairline bg-surface p-1 shadow-2xl shadow-black/50">
            <Link
              href="/"
              onClick={() => menuRef.current?.removeAttribute("open")}
              className="block rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Alle Kunden ansehen
            </Link>
          </div>
        </details>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 pb-4">
        {organizations.map((org) => {
          const isOpen = openOrgId === org.id;
          return (
            <div key={org.id}>
              <button
                type="button"
                onClick={() => setOpenOrgId(isOpen ? null : org.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <span className="truncate">{org.name}</span>
                <ChevronRightIcon
                  className={`h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform ${
                    isOpen ? "rotate-90" : ""
                  }`}
                />
              </button>
              {isOpen && (
                <div className="ml-3 space-y-0.5 border-l border-hairline py-0.5 pl-2">
                  {org.projects.map((project) => {
                    const active = pathname?.startsWith(`/projects/${project.id}`);
                    return (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}`}
                        aria-current={active ? "page" : undefined}
                        className={`block truncate rounded-lg px-2 py-1.5 text-sm transition-colors ${
                          active
                            ? "bg-accent-soft font-medium text-accent"
                            : "text-ink-3 hover:bg-surface-2 hover:text-ink"
                        }`}
                      >
                        {project.name}
                      </Link>
                    );
                  })}
                  {org.projects.length === 0 && (
                    <p className="px-2 py-1 text-xs text-ink-4">Keine Projekte</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {organizations.length === 0 && (
          <p className="px-2 text-sm text-ink-3">Noch keine Kunden angelegt.</p>
        )}
      </nav>

      {/* Schriftzug ist aus der Header-Leiste hierher gewandert – dort steht
          nur noch der Sidebar-Umschalter. */}
      <Link
        href="/"
        aria-label="Scrumy"
        title="Scrumy"
        className="flex shrink-0 items-center gap-2.5 border-t border-hairline px-4 py-3 text-sm font-semibold tracking-tight text-ink-2 transition-colors hover:text-ink"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-brand">
          <ScrumyMark className="h-5 w-5 -rotate-6" />
        </span>
        Scrumy
      </Link>
    </aside>
  );
}
