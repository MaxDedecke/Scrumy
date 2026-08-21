import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  CONCEPT_STATUS_LABEL,
  CONCEPT_STATUS_PILL,
  PRIORITY_LABEL,
  PRIORITY_PILL,
  REQUIREMENT_SOURCE_LABEL,
  REQUIREMENT_SOURCE_PILL,
} from "@/lib/labels";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Panel, PanelEmpty, PanelGrid } from "@/components/Panel";
import { Disclosure, formGridClass } from "@/components/Disclosure";
import { ConceptTemplateMenu } from "@/components/ConceptTemplateMenu";
import { GenerateRequirementsButton } from "@/components/GenerateRequirementsButton";
import { CheckIcon, PaperclipIcon, TrashIcon } from "@/components/icons";
import {
  approveRequirements,
  createRequirement,
  deleteRequirement,
  reopenRequirements,
} from "@/lib/actions/requirements";
import { releaseConcept, reopenConcept, saveConceptDraft } from "@/lib/actions/concept";
import { commissionExtension, startTeam } from "@/lib/actions/team";
import {
  buttonPrimaryClass,
  buttonSecondaryClass,
  iconButtonSmallDangerClass,
  inputClass,
  labelClass,
} from "@/lib/ui";
import type { Priority } from "@/generated/prisma/client";

// Immer live aus der DB rendern, nicht zur Build-Zeit einfrieren.
export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

export default async function ProjectDiscoveryPage({
  params,
}: PageProps<"/projects/[projectId]/discovery">) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
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
  // Auch ein pausiertes Team hat schon angefangen – hier gehoert dann kein
  // Start-Button mehr hin, sondern der Weg ins Buero.
  const teamStarted = project.status === "ACTIVE" || project.status === "PAUSED";
  const canStartTeam = conceptReleased && requirementsApproved;

  return (
    <PanelGrid className="lg:grid-cols-2 lg:grid-rows-[minmax(0,1.6fr)_minmax(0,1fr)]">
      {/* Konzept steht links und über beide Zeilen: Es ist der Text, an dem
          gearbeitet wird – das Textfeld füllt die volle Panelhöhe, statt bei
          rows=14 abzuschneiden. */}
      <Panel
        title="Konzept"
        className="card-ghost lg:row-span-2"
        scroll={false}
        action={
          <>
            {project.concept && (
              <span
                className={`${
                  conceptReleased ? CONCEPT_STATUS_PILL.FINALIZED : CONCEPT_STATUS_PILL.DRAFT
                } pill-dot`}
              >
                {conceptReleased
                  ? `Version ${latestVersion.version} freigegeben`
                  : CONCEPT_STATUS_LABEL.DRAFT}
              </span>
            )}
            <ConceptTemplateMenu projectId={project.id} hasConceptContent={hasConceptContent} />
          </>
        }
        footer={
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* Freigeben friert den aktuellen Text als Version ein. Weiter
                  bearbeiten bleibt erlaubt – das ergibt die nächste Version. */}
              <ActionForm action={releaseConcept}>
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText={
                    latestVersion
                      ? `Aktuellen Stand als Version ${latestVersion.version + 1} freigeben?`
                      : "Aktuellen Stand als Version 1 freigeben?"
                  }
                  className={`${buttonPrimaryClass} ${
                    !hasConceptContent || (conceptReleased && !conceptChangedSinceRelease)
                      ? "opacity-40"
                      : ""
                  }`}
                >
                  {latestVersion ? `Als Version ${latestVersion.version + 1} freigeben` : "Konzept freigeben"}
                </ConfirmButton>
              </ActionForm>

              {!hasConceptContent && (
                <span className="text-xs text-ink-3">Erst Konzept ausformulieren.</span>
              )}
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
                <ActionForm action={reopenConcept} className="ml-auto">
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmButton
                    confirmText="Freigabe zurückziehen? Die bisherigen Versionen bleiben als Historie erhalten, das Team lässt sich bis zur nächsten Freigabe nicht starten."
                    className="quiet-link text-xs font-medium"
                  >
                    Freigabe zurückziehen
                  </ConfirmButton>
                </ActionForm>
              )}
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              {versions.length > 0 && (
                <details className="min-w-0">
                  <summary className="disclosure-summary text-xs">
                    Freigegebene Versionen ({versions.length})
                  </summary>
                  <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-hairline p-3">
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
                          <pre className="max-h-64 overflow-auto border-t border-hairline p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                            {version.content}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          </div>
        }
      >
        <ActionForm action={saveConceptDraft} className="flex min-h-0 flex-1 flex-col gap-2.5">
          <input type="hidden" name="projectId" value={project.id} />
          {/* key erzwingt ein Remount, sobald sich der gespeicherte Entwurf
              ändert. Ohne das behält ein bereits angetipptes Textfeld seinen
              "dirty" Wert und würde die frisch eingefügte Vorlage nicht
              anzeigen, obwohl sie in der DB steht. */}
          <textarea
            key={project.concept?.updatedAt.toISOString() ?? "leer"}
            name="content"
            defaultValue={project.concept?.content ?? ""}
            placeholder="Konzept als Freitext, ausgearbeitet aus den Anforderungen …"
            className={`${inputClass} min-h-48 flex-1 resize-none font-mono text-xs leading-relaxed`}
          />
          <button type="submit" className={`${buttonSecondaryClass} self-start`}>
            Entwurf speichern
          </button>
        </ActionForm>
      </Panel>

      <Panel
        title="Anforderungen"
        className="card-ghost"
        count={project.requirements.length}
        padded={false}
        action={
          <GenerateRequirementsButton
            projectId={project.id}
            profileName={llmProfile?.name ?? null}
            compact
          />
        }
        footer={
          requirementsApproved ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="pill pill-good pill-dot">
                Freigegeben · {project.requirementsApprovedAt!.toLocaleString("de-DE")}
              </span>
              <ActionForm action={reopenRequirements} className="ml-auto">
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText="Freigabe der Anforderungen zurückziehen, um weiter zu ergänzen?"
                  className="quiet-link text-xs font-medium"
                >
                  Freigabe zurückziehen
                </ConfirmButton>
              </ActionForm>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ActionForm action={approveRequirements}>
                <input type="hidden" name="projectId" value={project.id} />
                <ConfirmButton
                  confirmText={`${project.requirements.length} Anforderungen als vollständig freigeben?`}
                  className={`${buttonPrimaryClass} ${
                    project.requirements.length === 0 ? "opacity-40" : ""
                  }`}
                >
                  Anforderungen freigeben
                </ConfirmButton>
              </ActionForm>
              <span className="min-w-0 flex-1 text-xs text-ink-3">
                {project.requirements.length === 0
                  ? "Erst Anforderungen erfassen oder generieren."
                  : "Bestätigt die Liste als vollständig – jede spätere Änderung hebt die Freigabe auf."}
              </span>
            </div>
          )
        }
      >
        {project.requirements.length === 0 ? (
          <PanelEmpty>Noch keine Anforderungen erfasst.</PanelEmpty>
        ) : (
          <ul className="divide-y divide-hairline">
            {project.requirements.map((req) => (
              <li key={req.id} className="group px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{req.title}</p>
                    {req.description && (
                      <p className="mt-0.5 whitespace-pre-line break-words text-xs leading-relaxed text-ink-3">
                        {req.description}
                      </p>
                    )}
                  </div>
                  <ActionForm action={deleteRequirement}>
                    <input type="hidden" name="id" value={req.id} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <ConfirmButton
                      confirmText={`Anforderung "${req.title}" löschen?`}
                      title={`Anforderung „${req.title}" löschen`}
                      className={iconButtonSmallDangerClass}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </ConfirmButton>
                  </ActionForm>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
              </li>
            ))}
          </ul>
        )}

        <div className="p-4">
          <Disclosure label="Anforderung erfassen / hochladen">
            <ActionForm action={createRequirement} encType="multipart/form-data" className={formGridClass}>
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
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel
        title={teamStarted ? "Weiterbauen" : "Team starten"}
        className="card-ghost"
        scroll={teamStarted}
      >
        {teamStarted ? (
          <>
            <p className="text-sm text-ink-2">
              {project.status === "PAUSED"
                ? "Die Arbeit des Teams ruht gerade – "
                : "Das Agenten-Team arbeitet bereits – "}
              <Link
                href={`/projects/${project.id}`}
                className="font-medium text-accent underline underline-offset-2"
              >
                ins Team-Büro
              </Link>{" "}
              gehen und zusehen.
            </p>
            <p className="mt-3 text-sm text-ink-2">
              Ist der bisherige Auftrag abgearbeitet, hält das Team an und fragt nach. Mit einer Ausbaustufe
              beauftragst du jederzeit selbst die nächste Runde: Sie wird als Beschluss festgehalten, liegt
              damit jedem Agenten vor, und der Product Owner plant den nächsten Sprint daraus. Bis dahin
              ergänzte Anforderungen gelten mit der Beauftragung als freigegeben.
            </p>
            <ActionForm action={commissionExtension} className="space-y-3 pt-4">
              <input type="hidden" name="projectId" value={project.id} />
              <div>
                <label className={labelClass} htmlFor="extension-goal">
                  Was soll als Nächstes dazukommen?
                </label>
                <textarea
                  id="extension-goal"
                  name="goal"
                  rows={4}
                  className={inputClass}
                  placeholder="z.B. Mehrsprachigkeit für die Oberfläche, Export als CSV, Testabdeckung für die Rechnungslogik …"
                />
              </div>
              <ConfirmButton
                confirmText="Ausbaustufe beauftragen? Das Team nimmt die Arbeit wieder auf und plant den nächsten Sprint daraus."
                className={buttonPrimaryClass}
              >
                Ausbaustufe beauftragen
              </ConfirmButton>
            </ActionForm>
          </>
        ) : (
          <>
            <ul className="space-y-2.5">
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

            <ActionForm action={startTeam} className="mt-auto flex flex-wrap items-center gap-3 pt-4">
              <input type="hidden" name="projectId" value={project.id} />
              <ConfirmButton
                confirmText="Agenten-Team jetzt starten? Es legt ein lokales Git-Repository an, liest den Auftrag und beginnt mit der Sprint-Planung."
                className={`${buttonPrimaryClass} ${canStartTeam ? "" : "opacity-40"}`}
              >
                Team starten
              </ConfirmButton>
              {!canStartTeam && (
                <span className="text-xs text-ink-3">
                  Erst beide Freigaben erteilen, dann wird der Button aktiv.
                </span>
              )}
            </ActionForm>
          </>
        )}
      </Panel>
    </PanelGrid>
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
