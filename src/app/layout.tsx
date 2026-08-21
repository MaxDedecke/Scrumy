import type { Metadata } from "next";
import "./globals.css";
import { prisma } from "@/lib/prisma";
import { AppShell } from "@/components/AppShell";
import { ToastProvider } from "@/components/Toast";

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
          <AppShell organizations={organizations}>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
