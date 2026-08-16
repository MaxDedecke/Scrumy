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
  REQUIREMENT_SOURCE_PILL,
} from "@/lib/labels";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PageHeader } from "@/components/PageHeader";
import { EmptyHint, Section } from "@/components/Section";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { GenerateRequirementsButton } from "@/components/GenerateRequirementsButton";
import { CheckIcon, PaperclipIcon } from "@/components/icons";
import {
  approveRequirements,
  createRequirement,
  deleteRequirement,
  reopenRequirements,
} from "@/lib/actions/requirements";
import {
  applyConceptTemplate,
  releaseConcept,
  reopenConcept,
  saveConceptDraft,
  startTeam,
} from "@/lib/actions/concept";
import { CONCEPT_TEMPLATES, CONCEPT_TEMPLATE_CATEGORIES } from "@/lib/conceptTemplates";
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
      concept: { include: { versions: { orderBy: { version: "desc" } } } },
    },
  });

  if (!project) notFound();

  // Dasselbe Profil, das die Server-Action nimmt: das Standardprofil aus den
  // globalen LLM-Einstellungen. Wird im Button angezeigt, damit sichtbar ist,
  // womit generiert wird.
  const llmProfile = await prisma.llmProfile.findFirst({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { name: true },
  });

  const conceptContent = (project.concept?.content ?? "").trim();
  const hasConceptContent = conceptContent.length > 0;
  const versions = project.concept?.versions ?? [];
  const latestVersion = versions[0];
  // Freigegeben heißt: es gibt eine Version UND die Freigabe wurde nicht
  // zurückgezogen. Der Text darf danach weiter bearbeitet werden – die nächste
  // Freigabe erzeugt dann Version N+1.
  const conceptReleased = project.concept?.status === "FINALIZED" && Boolean(latestVersion);
  const conceptChangedSinceRelease =
    Boolean(latestVersion) && latestVersion.content.trim() !== conceptContent;
  const requirementsApproved = Boolean(project.requirementsApprovedAt);
  const teamStarted = project.status === "ACTIVE";
  const canStartTeam = conceptReleased && requirementsApproved;

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

      {/* Konzept steht vor den Anforderungen: Der Weg ist Konzept schreiben (ggf.
          aus Vorlage) -> daraus Anforderungen ableiten. */}
      <Section
        title="Konzept"
        action={
          project.concept && (
            <span
              className={`${
                conceptReleased ? CONCEPT_STATUS_PILL.FINALIZED : CONCEPT_STATUS_PILL.DRAFT
              } pill-dot`}
            >
              {conceptReleased
                ? `Version ${latestVersion.version} freigegeben · ${latestVersion.releasedAt.toLocaleString("de-DE")}`
                : CONCEPT_STATUS_LABEL.DRAFT}
            </span>
          )
        }
      >
        {
          <Disclosure
            label={`Aus Vorlage starten – ${CONCEPT_TEMPLATES.length} SaaS-Ablösungen`}
            className="mb-3"
          >
            <p className="mb-5 max-w-3xl text-xs leading-relaxed text-ink-3">
              Jede Vorlage füllt das Konzeptfeld mit einem Entwurf für die Ablösung des jeweiligen
              Produkts: Ausgangslage, Ziel, Kernmodule, bewusste Abgrenzung und offene Punkte.
              Ein Ausgangspunkt fürs Kundengespräch, kein fertiges Konzept.
              {hasConceptContent && " Ein vorhandener Entwurf wird dabei überschrieben."}
            </p>
            <form action={applyConceptTemplate} className="space-y-6">
              <input type="hidden" name="projectId" value={project.id} />
              {CONCEPT_TEMPLATE_CATEGORIES.map((category) => {
                const templates = CONCEPT_TEMPLATES.filter((t) => t.category === category);
                if (templates.length === 0) return null;
                return (
                  <div key={category}>
                    <h3 className="section-title mb-2">{category}</h3>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {templates.map((template) => (
                        <ConfirmButton
                          key={template.id}
                          name="templateId"
                          value={template.id}
                          confirmText={
                            hasConceptContent
                              ? `Vorhandenen Konzept-Entwurf durch die Vorlage „${template.name}" ersetzen?`
                              : null
                          }
                          className="card-interactive block p-3 text-left"
                        >
                          <span className="block text-sm font-medium text-ink">
                            Eigenes {template.name}
                          </span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">
                            {template.what}
                          </span>
                        </ConfirmButton>
                      ))}
                    </div>
                  </div>
                );
              })}
            </form>
          </Disclosure>
        }

        <div className="card p-5">
          <form action={saveConceptDraft} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            {/* key erzwingt ein Remount, sobald sich der gespeicherte Entwurf
                ändert. Ohne das behält ein bereits angetipptes Textfeld seinen
                "dirty" Wert und würde die frisch eingefügte Vorlage nicht
                anzeigen, obwohl sie in der DB steht. */}
            <textarea
              key={project.concept?.updatedAt.toISOString() ?? "leer"}
              name="content"
              rows={14}
              defaultValue={project.concept?.content ?? ""}
              placeholder="Konzept als Freitext, ausgearbeitet aus den Anforderungen …"
              className={`${inputClass} font-mono text-xs leading-relaxed`}
            />
            <button type="submit" className={buttonSecondaryClass}>
              Entwurf speichern
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-hairline pt-5">
            {/* Freigeben friert den aktuellen Text als Version ein. Weiter
                bearbeiten bleibt erlaubt – das ergibt dann die nächste Version. */}
            <form action={releaseConcept}>
              <input type="hidden" name="projectId" value={project.id} />
              <ConfirmButton
                confirmText={
                  latestVersion
                    ? `Aktuellen Stand als Version ${latestVersion.version + 1} freigeben?`
                    : "Aktuellen Stand als Version 1 freigeben?"
                }
                className={`${buttonPrimaryClass} ${
                  !hasConceptContent || (conceptReleased && !conceptChangedSinceRelease)
                    ? "pointer-events-none opacity-40"
                    : ""
                }`}
              >
                {latestVersion ? `Als Version ${latestVersion.version + 1} freigeben` : "Konzept freigeben"}
              </ConfirmButton>
            </form>

            {!hasConceptContent && <span className="text-xs text-ink-3">Erst Konzept ausformulieren.</span>}

            {conceptReleased && !conceptChangedSinceRelease && (
              <span className="text-xs text-ink-3">
                Version {latestVersion.version} entspricht dem aktuellen Stand.
              </span>
            )}
            {conceptReleased && conceptChangedSinceRelease && (
              <span className="text-xs text-warning">
                Änderungen seit Version {latestVersion.version} – noch nicht freigegeben.
              </span>
            )}

            {conceptReleased && (
              <form action={reopenConcept} className="ml-auto">
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText="Freigabe zurückziehen? Die bisherigen Versionen bleiben als Historie erhalten, das Team lässt sich bis zur nächsten Freigabe nicht starten."
                  className="quiet-link text-xs font-medium"
                >
                  Freigabe zurückziehen
                </ConfirmButton>
              </form>
            )}
          </div>
        </div>

        {versions.length > 0 && (
          <Disclosure label={`Freigegebene Versionen (${versions.length})`} className="mt-3">
            <ol className="space-y-2">
              {versions.map((version) => (
                <li key={version.id}>
                  <details className="card overflow-hidden bg-surface-2/50">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm">
                      <span className="pill pill-neutral">Version {version.version}</span>
                      <span className="tabular-nums text-xs text-ink-2">
                        {version.releasedAt.toLocaleString("de-DE")}
                      </span>
                      <span className="ml-auto text-xs text-ink-4">
                        {version.content.length.toLocaleString("de-DE")} Zeichen
                      </span>
                    </summary>
                    <pre className="max-h-96 overflow-auto border-t border-hairline p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                      {version.content}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          </Disclosure>
        )}
      </Section>

      <Section title="Anforderungen" className="mb-0">
        <div className="card mb-3 p-4">
          <p className="mb-3 max-w-2xl text-xs leading-relaxed text-ink-3">
            Der Product-Owner-Agent liest das Konzept und leitet daraus Anforderungen ab. Bestehende
            bleiben erhalten, neue kommen als &bdquo;KI-generiert&ldquo; dazu und wollen geprüft werden.
          </p>
          <GenerateRequirementsButton projectId={project.id} profileName={llmProfile?.name ?? null} />
        </div>

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
                <span className={REQUIREMENT_SOURCE_PILL[req.source]}>
                  {REQUIREMENT_SOURCE_LABEL[req.source]}
                </span>
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

        {/* Freigabe der Anforderungsliste – zweite Voraussetzung fürs Team. */}
        <div className="card mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          {requirementsApproved ? (
            <>
              <span className="pill pill-good pill-dot">
                Freigegeben · {project.requirementsApprovedAt!.toLocaleString("de-DE")}
              </span>
              <span className="text-xs text-ink-3">
                {project.requirements.length} Anforderung
                {project.requirements.length === 1 ? "" : "en"} bestätigt.
              </span>
              <form action={reopenRequirements} className="ml-auto">
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText="Freigabe der Anforderungen zurückziehen, um weiter zu ergänzen?"
                  className="quiet-link text-xs font-medium"
                >
                  Freigabe zurückziehen
                </ConfirmButton>
              </form>
            </>
          ) : (
            <>
              <form action={approveRequirements}>
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText={`${project.requirements.length} Anforderungen als vollständig freigeben?`}
                  className={`${buttonPrimaryClass} ${
                    project.requirements.length === 0 ? "pointer-events-none opacity-40" : ""
                  }`}
                >
                  Anforderungen freigeben
                </ConfirmButton>
              </form>
              <span className="text-xs text-ink-3">
                {project.requirements.length === 0
                  ? "Erst Anforderungen erfassen oder generieren."
                  : "Bestätigt die Liste als vollständig – jede spätere Änderung hebt die Freigabe wieder auf."}
              </span>
            </>
          )}
        </div>
      </Section>

      <Section title="Team starten" className="mb-0">
        <div className="card p-5">
          {teamStarted ? (
            <p className="text-sm text-ink-2">
              Das Agenten-Team arbeitet bereits –{" "}
              <Link href={`/projects/${project.id}`} className="font-medium text-accent underline underline-offset-2">
                zum Scrum-Board
              </Link>
              .
            </p>
          ) : (
            <>
              <ul className="mb-5 space-y-2.5">
                <ChecklistItem
                  done={conceptReleased}
                  label="Konzept freigegeben"
                  detail={
                    conceptReleased
                      ? `Version ${latestVersion.version} · ${latestVersion.releasedAt.toLocaleString("de-DE")}`
                      : "noch keine Version freigegeben"
                  }
                />
                <ChecklistItem
                  done={requirementsApproved}
                  label="Anforderungen freigegeben"
                  detail={
                    requirementsApproved
                      ? project.requirementsApprovedAt!.toLocaleString("de-DE")
                      : "noch nicht bestätigt"
                  }
                />
              </ul>

              <form action={startTeam} className="flex flex-wrap items-center gap-4">
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText="Agenten-Team jetzt starten? Das Projekt wechselt auf Aktiv."
                  className={`${buttonPrimaryClass} ${canStartTeam ? "" : "pointer-events-none opacity-40"}`}
                >
                  Team starten
                </ConfirmButton>
                {!canStartTeam && (
                  <span className="text-xs text-ink-3">
                    Erst beide Freigaben erteilen, dann wird der Button aktiv.
                  </span>
                )}
              </form>
            </>
          )}
        </div>
      </Section>
    </main>
  );
}

/// Eine Voraussetzung fürs Team-Starten, abgehakt oder offen.
function ChecklistItem({
  done,
  label,
  detail,
}: {
  done: boolean;
  label: string;
  detail: string;
}) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          done ? "border-good bg-good/20 text-good" : "border-hairline-strong"
        }`}
      >
        {done && <CheckIcon className="h-2.5 w-2.5" />}
      </span>
      <span className="min-w-0">
        <span className={done ? "text-ink" : "text-ink-2"}>{label}</span>
        <span className="ml-2 text-xs text-ink-3">{detail}</span>
      </span>
    </li>
  );
}
