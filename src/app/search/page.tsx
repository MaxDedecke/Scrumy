import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { ArrowRightIcon } from "@/components/icons";
import { pageClass } from "@/lib/ui";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  const [organizations, projects] = query
    ? await Promise.all([
        prisma.organization.findMany({
          where: { name: { contains: query, mode: "insensitive" } },
          orderBy: { name: "asc" },
        }),
        prisma.project.findMany({
          where: { name: { contains: query, mode: "insensitive" } },
          orderBy: { name: "asc" },
          include: { organization: true },
        }),
      ])
    : [[], []];

  const hasResults = organizations.length > 0 || projects.length > 0;

  return (
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context="Suche"
        title={query ? `Ergebnisse für „${query}“` : "Kunden & Projekte durchsuchen"}
        description={
          query
            ? undefined
            : "Suchbegriff oben in der Kopfzeile eingeben – gesucht wird in Kunden- und Projektnamen."
        }
      />

      {query && !hasResults && <EmptyHint>Keine Kunden oder Projekte gefunden.</EmptyHint>}

      {organizations.length > 0 && (
        <Section title="Kunden">
          <div className="space-y-2">
            {organizations.map((org) => (
              <Link
                key={org.id}
                href={`/organizations/${org.id}/inbox`}
                className="card-interactive group flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{org.name}</p>
                  <p className="truncate text-sm text-ink-3">{org.industry ?? "Support-Postfach"}</p>
                </div>
                <ArrowRightIcon className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-2" />
              </Link>
            ))}
          </div>
        </Section>
      )}

      {projects.length > 0 && (
        <Section title="Projekte" className="mb-0">
          <div className="space-y-2">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="card-interactive group flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{project.name}</p>
                  <p className="truncate text-sm text-ink-3">{project.organization.name}</p>
                </div>
                <ArrowRightIcon className="h-4 w-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-2" />
              </Link>
            ))}
          </div>
        </Section>
      )}
    </main>
  );
}
