import Link from "next/link";

export function ProjectTabs({
  projectId,
  active,
}: {
  projectId: string;
  active: "overview" | "team";
}) {
  const tabs = [
    { key: "overview", label: "Übersicht", href: `/projects/${projectId}` },
    { key: "team", label: "Team & Konnektoren", href: `/projects/${projectId}/team` },
  ] as const;

  return (
    <nav className="mb-6 flex gap-1 border-b border-neutral-900">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`border-b-2 px-3 py-2 text-sm transition-colors ${
            tab.key === active
              ? "border-sky-500 text-neutral-100"
              : "border-transparent text-neutral-500 hover:text-neutral-300"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
