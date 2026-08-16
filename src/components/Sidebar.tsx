"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, EllipsisIcon, PanelLeftIcon } from "@/components/icons";

type SidebarProject = { id: string; name: string };
type SidebarOrganization = { id: string; name: string; projects: SidebarProject[] };

const COLLAPSE_STORAGE_KEY = "scrumy:sidebar-collapsed";

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

  // Eingeklappt-Zustand pro Browser gemerkt. SSR kennt localStorage nicht,
  // also startet die Sidebar immer ausgeklappt und zieht die gespeicherte
  // Präferenz erst nach dem Mount nach (kein Hydration-Mismatch).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1");
  }, []);
  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <aside
      className={`flex shrink-0 flex-col overflow-y-auto border-r border-neutral-900 transition-[width] duration-200 ${
        collapsed ? "w-12" : "w-64"
      }`}
    >
      <div className={`flex items-center py-3 ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
        {!collapsed && (
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Kunden
          </span>
        )}
        <div className="flex items-center gap-1">
          {!collapsed && (
            <details ref={menuRef} className="relative">
              <summary
                className="flex cursor-pointer list-none items-center rounded-md p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                aria-label="Mehr Optionen"
              >
                <EllipsisIcon className="h-5 w-5" />
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
                <Link
                  href="/"
                  onClick={() => menuRef.current?.removeAttribute("open")}
                  className="block rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900"
                >
                  Alle Kunden ansehen
                </Link>
              </div>
            </details>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
            title={collapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
            className="flex shrink-0 items-center rounded-md p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
          >
            <PanelLeftIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <nav className="flex-1 space-y-0.5 px-2 pb-4">
          {organizations.map((org) => {
            const isOpen = openOrgId === org.id;
            return (
              <div key={org.id}>
                <button
                  type="button"
                  onClick={() => setOpenOrgId(isOpen ? null : org.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
                >
                  <span className="truncate">{org.name}</span>
                  <ChevronRightIcon
                    className={`h-3.5 w-3.5 shrink-0 text-neutral-600 transition-transform ${
                      isOpen ? "rotate-90" : ""
                    }`}
                  />
                </button>
                {isOpen && (
                  <div className="ml-2 space-y-0.5 border-l border-neutral-900 pl-2">
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
                )}
              </div>
            );
          })}
          {organizations.length === 0 && (
            <p className="px-2 text-sm text-neutral-600">Noch keine Kunden angelegt.</p>
          )}
        </nav>
      )}
    </aside>
  );
}
