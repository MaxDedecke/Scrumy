import Link from "next/link";

// Segmentierte Umschaltung statt Unterstrich-Tabs: Das Grid gibt allen Tabs
// exakt dieselbe Breite, unabhängig von der Länge der Beschriftung.
export function ProjectTabs({
  projectId,
  active,
}: {
  projectId: string;
  active: "overview" | "discovery" | "office" | "records" | "team";
}) {
  const tabs = [
    { key: "overview", label: "Übersicht", href: `/projects/${projectId}` },
    { key: "discovery", label: "Anforderungen & Konzept", href: `/projects/${projectId}/discovery` },
    { key: "office", label: "Team-Büro", href: `/projects/${projectId}/office` },
    { key: "records", label: "Nachweise", href: `/projects/${projectId}/records` },
    { key: "team", label: "Team & Connectoren", href: `/projects/${projectId}/team` },
  ] as const;

  return (
    <nav
      aria-label="Projektbereiche"
      className="mb-8 grid grid-cols-5 gap-1 rounded-xl border border-hairline bg-surface p-1"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={`truncate rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
              isActive
                ? "bg-surface-3 text-ink"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
