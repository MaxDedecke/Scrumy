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
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { PaperclipIcon } from "@/components/icons";
import { createRequirement, deleteRequirement } from "@/lib/actions/requirements";
import { finalizeConceptAndStartTeam, reopenConcept, saveConceptDraft } from "@/lib/actions/concept";
import {
  buttonDangerQuietClass,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
  labelClass,
  pageClass,
} from "@/lib/ui";
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
    <main className={pageClass}>
      <PageHeader
        backHref="/"
        backLabel="Kunden"
        context={project.organization.name}
        title={project.name}
        status={
          <span className={`${PROJECT_STATUS_PILL[project.status]} pill-dot`}>
            {PROJECT_STATUS_LABEL[project.status]}
          </span>
        }
      />

      <ProjectTabs projectId={project.id} active="discovery" />

      {project.status === "ACTIVE" && (
        <p className="mb-8 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm text-ink-2">
          Konzept ist freigegeben, das Agenten-Team arbeitet bereits nach Scrum – siehe{" "}
          <Link href={`/projects/${project.id}`} className="font-medium text-accent underline underline-offset-2">
            Scrum-Board
          </Link>
          . Anforderungen und Konzept können hier weiter gepflegt werden.
        </p>
      )}

      <Section title="Anforderungen">
        <div className="space-y-2">
          {project.requirements.map((req) => (
            <div key={req.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{req.title}</p>
                  {req.description && (
                    <p className="mt-1 text-xs leading-relaxed text-ink-3">{req.description}</p>
                  )}
                </div>
                <form action={deleteRequirement} className="shrink-0">
                  <input type="hidden" name="id" value={req.id} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmButton
                    confirmText={`Anforderung "${req.title}" löschen?`}
                    className={buttonDangerQuietClass}
                  >
                    Entfernen
                  </ConfirmButton>
                </form>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className={PRIORITY_PILL[req.priority]}>{PRIORITY_LABEL[req.priority]}</span>
                <span className="pill pill-neutral">{REQUIREMENT_SOURCE_LABEL[req.source]}</span>
                {req.fileName && (
                  <a href={`/requirements/${req.id}/download`} className="pill pill-neutral hover:text-ink">
                    <PaperclipIcon className="h-3 w-3" />
                    {req.fileName}
                  </a>
                )}
              </div>
            </div>
          ))}
          {project.requirements.length === 0 && <EmptyHint>Noch keine Anforderungen erfasst.</EmptyHint>}
        </div>

        <Disclosure label="Anforderung erfassen / hochladen" className="mt-3">
          <form action={createRequirement} encType="multipart/form-data" className={formGridClass}>
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
              <label className={labelClass}>
                Datei (optional, z.B. Lastenheft) – ohne Titel wird der Dateiname übernommen
              </label>
              <input
                type="file"
                name="file"
                className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-sm file:text-ink hover:file:bg-hairline-strong"
              />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonSecondaryClass}>
                Anforderung speichern
              </button>
            </div>
          </form>
        </Disclosure>
      </Section>

      <Section
        title="Konzept"
        className="mb-0"
        action={
          project.concept && (
            <span className={`${CONCEPT_STATUS_PILL[project.concept.status]} pill-dot`}>
              {CONCEPT_STATUS_LABEL[project.concept.status]}
              {project.concept.finalizedAt && ` · ${project.concept.finalizedAt.toLocaleString("de-DE")}`}
            </span>
          )
        }
      >
        <div className="card p-5">
          <form action={saveConceptDraft} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            <textarea
              name="content"
              rows={14}
              readOnly={isFinalized}
              defaultValue={project.concept?.content ?? ""}
              placeholder="Konzept als Freitext, ausgearbeitet aus den obigen Anforderungen …"
              className={`${inputClass} font-mono text-xs leading-relaxed ${isFinalized ? "opacity-70" : ""}`}
            />
            {!isFinalized && (
              <button type="submit" className={buttonSecondaryClass}>
                Entwurf speichern
              </button>
            )}
          </form>

          <div className="mt-5 border-t border-hairline pt-5">
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
        </div>
      </Section>
    </main>
  );
}
