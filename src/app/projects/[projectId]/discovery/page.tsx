import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  CONCEPT_STATUS_LABEL,
  CONCEPT_STATUS_PILL,
  PRIORITY_LABEL,
  PRIORITY_PILL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_PILL,
  REQUIREMENT_SOURCE_LABEL,
} from "@/lib/labels";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ConfirmButton } from "@/components/ConfirmButton";
import { createRequirement, deleteRequirement } from "@/lib/actions/requirements";
import { finalizeConceptAndStartTeam, reopenConcept, saveConceptDraft } from "@/lib/actions/concept";
import { buttonPrimaryClass, buttonSecondaryClass, inputClass, labelClass } from "@/lib/ui";
import type { Priority } from "@/generated/prisma/client";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

export default async function ProjectDiscoveryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      organization: true,
      requirements: { orderBy: { createdAt: "desc" } },
      concept: true,
    },
  });

  if (!project) notFound();

  const isFinalized = project.concept?.status === "FINALIZED";

  return (
    <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
          ← Kunden &amp; Projekte
        </Link>
        <div className="mt-2 flex items-baseline gap-3">
          <div>
            <p className="text-sm uppercase tracking-wider text-neutral-500">{project.organization.name}</p>
            <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
          </div>
          <span className={PROJECT_STATUS_PILL[project.status]}>{PROJECT_STATUS_LABEL[project.status]}</span>
        </div>
      </header>

      <ProjectTabs projectId={project.id} active="discovery" />

      {project.status === "ACTIVE" && (
        <p className="mb-8 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-400">
          Konzept ist freigegeben, das Agenten-Team arbeitet bereits nach Scrum – siehe{" "}
          <Link href={`/projects/${project.id}`} className="underline hover:text-neutral-300">
            Scrum-Board
          </Link>
          . Anforderungen/Konzept können hier weiter gepflegt werden.
        </p>
      )}

      {/* Anforderungen */}
      <section className="mb-10">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-neutral-500">Anforderungen</h2>
        <div className="space-y-3">
          {project.requirements.map((req) => (
            <div key={req.id} className="rounded-md border border-neutral-800 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{req.title}</p>
                  {req.description && <p className="mt-1 text-xs text-neutral-500">{req.description}</p>}
                </div>
                <form action={deleteRequirement}>
                  <input type="hidden" name="id" value={req.id} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmButton
                    confirmText={`Anforderung "${req.title}" löschen?`}
                    className="shrink-0 text-xs text-red-400 hover:text-red-300"
                  >
                    Entfernen
                  </ConfirmButton>
                </form>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className={PRIORITY_PILL[req.priority]}>{PRIORITY_LABEL[req.priority]}</span>
                <span className="pill pill-neutral">{REQUIREMENT_SOURCE_LABEL[req.source]}</span>
                {req.fileName && (
                  <a
                    href={`/requirements/${req.id}/download`}
                    className="pill pill-neutral hover:text-neutral-100"
                  >
                    📎 {req.fileName}
                  </a>
                )}
              </div>
            </div>
          ))}
          {project.requirements.length === 0 && (
            <p className="text-sm text-neutral-600">Noch keine Anforderungen erfasst.</p>
          )}
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer select-none text-sm text-neutral-500 hover:text-neutral-300">
            + Anforderung erfassen / hochladen
          </summary>
          <form
            action={createRequirement}
            encType="multipart/form-data"
            className="mt-3 grid gap-3 rounded-md border border-neutral-900 p-4 sm:grid-cols-2"
          >
            <input type="hidden" name="projectId" value={project.id} />
            <div>
              <label className={labelClass}>Titel</label>
              <input
                name="title"
                className={inputClass}
                placeholder="z.B. Artikelstamm mit Variantenverwaltung"
              />
            </div>
            <div>
              <label className={labelClass}>Priorität</label>
              <select name="priority" className={inputClass} defaultValue="MEDIUM">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Beschreibung (optional)</label>
              <textarea name="description" rows={2} className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Datei (optional, z.B. Lastenheft) – ohne Titel wird der Dateiname übernommen</label>
              <input
                type="file"
                name="file"
                className="block w-full text-sm text-neutral-400 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-200 hover:file:bg-neutral-700"
              />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonSecondaryClass}>
                Anforderung speichern
              </button>
            </div>
          </form>
        </details>
      </section>

      {/* Konzept */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">Konzept</h2>
          {project.concept && (
            <span className={CONCEPT_STATUS_PILL[project.concept.status]}>
              {CONCEPT_STATUS_LABEL[project.concept.status]}
              {project.concept.finalizedAt &&
                ` · ${project.concept.finalizedAt.toLocaleString("de-DE")}`}
            </span>
          )}
        </div>

        <form action={saveConceptDraft} className="space-y-3">
          <input type="hidden" name="projectId" value={project.id} />
          <textarea
            name="content"
            rows={12}
            readOnly={isFinalized}
            defaultValue={project.concept?.content ?? ""}
            placeholder="Konzept als Freitext, ausgearbeitet aus den obigen Anforderungen …"
            className={`${inputClass} font-mono ${isFinalized ? "opacity-70" : ""}`}
          />
          {!isFinalized && (
            <button type="submit" className={buttonSecondaryClass}>
              Entwurf speichern
            </button>
          )}
        </form>

        <div className="mt-4 flex items-center gap-3 border-t border-neutral-900 pt-4">
          {isFinalized ? (
            <form action={reopenConcept}>
              <input type="hidden" name="projectId" value={project.id} />
              <ConfirmButton
                confirmText="Freigabe zurückziehen? Projekt fällt zurück in die Konzeptphase, laufende Tickets/Agenten bleiben unangetastet."
                className={buttonSecondaryClass}
              >
                Freigabe zurückziehen
              </ConfirmButton>
            </form>
          ) : (
            <form action={finalizeConceptAndStartTeam}>
              <input type="hidden" name="projectId" value={project.id} />
              <ConfirmButton
                confirmText="Konzept freigeben und Agenten-Team starten? Projekt wechselt auf ACTIVE."
                className={buttonPrimaryClass}
              >
                Konzept freigeben &amp; Team starten
              </ConfirmButton>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
