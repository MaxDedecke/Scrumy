import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { prisma } from "@/lib/prisma";
import { Sidebar } from "@/components/Sidebar";
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
      <body className="flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-100 font-sans">
        <header className="shrink-0 border-b border-neutral-900">
          <div className="flex items-center gap-4 px-6 py-3">
            <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-sky-500 text-sm text-white">
                S
              </span>
              Scrumy
            </Link>

            <form action="/search" className="w-full max-w-md">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
                <input
                  type="search"
                  name="q"
                  placeholder="Kunden, Projekte durchsuchen…"
                  className="w-full rounded-md border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
                />
              </div>
            </form>

            <div className="flex-1" />

            <Link
              href="/settings/llm-profiles"
              aria-label="Einstellungen"
              title="Einstellungen"
              className="shrink-0 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
            >
              <SettingsIcon className="h-5 w-5" />
            </Link>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <Sidebar organizations={organizations} />
          <div className="flex flex-1 flex-col overflow-y-auto">{children}</div>
        </div>
      </body>
    </html>
  );
}
