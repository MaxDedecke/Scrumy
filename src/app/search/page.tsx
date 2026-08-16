import Link from "next/link";
import { prisma } from "@/lib/prisma";

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
    <main className="flex-1 mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-wider text-neutral-500">Suche</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {query ? (
            <>
              Ergebnisse für &bdquo;{query}&ldquo;
            </>
          ) : (
            "Kunden & Projekte durchsuchen"
          )}
        </h1>
      </header>

      {!query && <p className="text-neutral-500">Suchbegriff oben in der Kopfzeile eingeben.</p>}

      {query && !hasResults && (
        <p className="text-neutral-500">Keine Kunden oder Projekte gefunden.</p>
      )}

      {organizations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Kunden
          </h2>
          <div className="space-y-2">
            {organizations.map((org) => (
              <Link
                key={org.id}
                href={`/organizations/${org.id}/inbox`}
                className="flex items-center justify-between rounded-md border border-neutral-800 px-4 py-3 hover:border-neutral-600 hover:bg-neutral-900"
              >
                <div>
                  <p className="font-medium">{org.name}</p>
                  {org.industry && <p className="text-sm text-neutral-500">{org.industry}</p>}
                </div>
                <span aria-hidden className="text-neutral-500">
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {projects.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
            Projekte
          </h2>
          <div className="space-y-2">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="flex items-center justify-between rounded-md border border-neutral-800 px-4 py-3 hover:border-neutral-600 hover:bg-neutral-900"
              >
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-neutral-500">{project.organization.name}</p>
                </div>
                <span aria-hidden className="text-neutral-500">
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
