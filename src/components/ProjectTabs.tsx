"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Segmentierte Umschaltung statt Unterstrich-Tabs: Das Grid gibt allen Tabs
// exakt dieselbe Breite, unabhängig von der Länge der Beschriftung.
//
// Welcher Tab aktiv ist, kommt aus dem Pfad und nicht als Prop: Die Leiste
// steht im Projekt-Layout (einmal für alle Tabs), und ein Layout kennt die
// aktive Unterseite nicht.
export function ProjectTabs({ projectId, className = "" }: { projectId: string; className?: string }) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;

  const tabs = [
    { label: "Übersicht", href: base },
    { label: "Anforderungen & Konzept", href: `${base}/discovery` },
    { label: "Team-Büro", href: `${base}/office` },
    { label: "Benutzeroberfläche", href: `${base}/preview` },
    { label: "Code", href: `${base}/code` },
    { label: "Nachweise", href: `${base}/records` },
    { label: "Team & Einstellungen", href: `${base}/team` },
  ];

  return (
    <nav
      aria-label="Projektbereiche"
      className={`shrink-0 grid grid-cols-7 gap-1 rounded-xl border border-hairline bg-surface p-1 ${className}`}
    >
      {tabs.map((tab) => {
        // Unterseiten zählen zu ihrem Tab (ein Commit-Diff liegt unter
        // „Nachweise"); die Übersicht ist nur der Pfad selbst.
        const isActive = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={`truncate rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
              isActive ? "bg-surface-3 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
