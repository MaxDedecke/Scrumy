import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { prisma } from "@/lib/prisma";
import { Sidebar } from "@/components/Sidebar";
import { SidebarToggle } from "@/components/SidebarToggle";
import { ToastProvider } from "@/components/Toast";
import { SearchIcon, SettingsIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Scrumy",
  description: "Agenten-Scrum-Teams, die Individualsoftware für Kunden bauen und warten.",
};

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren (Sidebar-Inhalt).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      projects: { orderBy: { createdAt: "asc" }, select: { id: true, name: true } },
    },
  });

  return (
    <html lang="de" className="h-full antialiased">
      <body className="flex h-full flex-col overflow-hidden bg-canvas font-sans text-ink">
        {/* Toast-Stapel liegt im Root-Layout: Jede Aktion der App meldet ihr
            Ergebnis oben rechts, und die Meldung überlebt den Seitenwechsel. */}
        <ToastProvider>
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

              <Link
                href="/settings/llm-profiles"
                aria-label="Einstellungen"
                title="Einstellungen"
                className="shrink-0 rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <SettingsIcon className="h-5 w-5" />
              </Link>
            </div>
          </header>

          <div className="flex flex-1 overflow-hidden">
            <Sidebar organizations={organizations} />
            <div className="flex flex-1 flex-col overflow-y-auto">{children}</div>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
