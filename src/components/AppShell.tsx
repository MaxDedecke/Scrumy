"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SidebarToggle } from "@/components/SidebarToggle";
import { SettingsToggle } from "@/components/SettingsToggle";
import { Sidebar } from "@/components/Sidebar";
import { SearchIcon } from "@/components/icons";

type SidebarProject = { id: string; name: string };
type SidebarOrganization = { id: string; name: string; projects: SidebarProject[] };

// Kopfzeile + Sidebar waren bisher direkt im Root-Layout – dort waren sie
// wirklich fuer JEDE Seite richtig. Der Live-Boot (/live/[projectId], siehe
// LiveBoot.tsx) ist die erste Ausnahme: ein fensterfuellendes Erlebnis, das
// keine Such-/Kunden-Chrome darum vertraegt. Root-Layout bleibt trotzdem die
// EINZIGE Stelle mit <html>/<body> (kein zweites Root-Layout per Routengruppe
// noetig, das wuerde einen vollen Seiten-Reload beim Wechsel zwischen den
// Routengruppen erzwingen) – dieser Client-Wrapper entscheidet nur, ob die
// Chrome drumherum mitgerendert wird.
export function AppShell({
  organizations,
  children,
}: {
  organizations: SidebarOrganization[];
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const fullscreen = pathname.startsWith("/live/");

  if (fullscreen) return <>{children}</>;

  return (
    <>
      <header className="shrink-0 border-b border-hairline bg-canvas-raised">
        <div className="flex h-14 items-center gap-5 px-5">
          <SidebarToggle />

          <form action="/search" className="w-full max-w-sm">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
              <input
                type="search"
                name="q"
                placeholder="Kunden, Projekte durchsuchen…"
                className="w-full rounded-lg border border-hairline bg-surface py-2 pl-9 pr-3 text-sm text-ink transition-colors placeholder:text-ink-4 focus:border-accent-border focus:bg-surface-2 focus:outline-none"
              />
            </div>
          </form>

          <div className="flex-1" />

          <SettingsToggle />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar organizations={organizations} />
        <div className="flex flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
