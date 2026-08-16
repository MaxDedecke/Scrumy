"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { findConceptTemplate, renderConceptTemplate } from "@/lib/conceptTemplates";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Speichert den Konzept-Entwurf (Freitext). Setzt bei Bedarf den Projekt-Status
/// von DISCOVERY auf CONCEPT, sobald zum ersten Mal am Konzept gearbeitet wird.
export async function saveConceptDraft(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  const content = String(formData.get("content") ?? "");
  if (!projectId) return fail("Kein Projekt angegeben.");

  await prisma.$transaction(async (tx) => {
    await tx.concept.upsert({
      where: { projectId },
      create: { projectId, content },
      update: { content },
    });

    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    if (project.status === "DISCOVERY") {
      await tx.project.update({ where: { id: projectId }, data: { status: "CONCEPT" } });
    }
  });

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);

  const length = content.trim().length;
  return length === 0
    ? note("Leerer Konzept-Entwurf gespeichert.")
    : ok(`Konzept-Entwurf gespeichert (${length.toLocaleString("de-DE")} Zeichen).`);
}

/// Fuellt das Konzept mit einer Vorlage vor ("baut mir ein eigenes <SaaS>").
/// Ueberschreibt den aktuellen Arbeitsstand bewusst komplett – die
/// Bestaetigung dafuer holt die Oberflaeche ein. Bereits freigegebene
/// `ConceptVersion`s bleiben davon unberuehrt, die sind eingefroren.
export async function applyConceptTemplate(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  const templateId = str(formData, "templateId");
  if (!projectId) return fail("Kein Projekt angegeben.");
  if (!templateId) return fail("Keine Vorlage ausgewählt.");

  const template = findConceptTemplate(templateId);
  if (!template) return fail("Diese Vorlage gibt es nicht (mehr).");

  const content = renderConceptTemplate(template);

  await prisma.$transaction(async (tx) => {
    await tx.concept.upsert({
      where: { projectId },
      create: { projectId, content },
      update: { content },
    });

    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    if (project.status === "DISCOVERY") {
      await tx.project.update({ where: { id: projectId }, data: { status: "CONCEPT" } });
    }

    await tx.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "concept_template_applied",
        detail: `Konzept-Vorlage „${template.name}“ eingefügt`,
      },
    });
  });

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok(`Vorlage „${template.name}“ in den Konzept-Entwurf übernommen.`);
}

/// Friert den aktuellen Konzeptstand als neue `ConceptVersion` ein.
///
/// Startet bewusst NICHT mehr das Team – das ist ein eigener Schritt
/// (`startTeam`), der zusaetzlich freigegebene Anforderungen verlangt.
/// Weiterarbeiten am Konzept bleibt erlaubt: Die naechste Freigabe erzeugt
/// dann Version N+1, alte Versionen bleiben unveraendert.
export async function releaseConcept(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const concept = await prisma.concept.findUnique({
    where: { projectId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!concept) return fail("Es gibt noch kein Konzept zum Freigeben.");

  const content = concept.content.trim();
  if (content.length === 0) return fail("Der Konzept-Entwurf ist leer – erst ausformulieren.");

  // Identischen Text nicht doppelt versionieren – sonst sammeln sich
  // inhaltsgleiche Versionen an, sobald jemand zweimal klickt.
  const latest = concept.versions[0];
  if (latest && latest.content.trim() === content) {
    return note(`Version ${latest.version} entspricht bereits diesem Stand – keine neue Version angelegt.`);
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  const releasedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.conceptVersion.create({
      data: { conceptId: concept.id, version: nextVersion, content: concept.content, releasedAt },
    });
    await tx.concept.update({
      where: { projectId },
      data: { status: "FINALIZED", finalizedAt: releasedAt },
    });

    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    if (project.status === "DISCOVERY") {
      await tx.project.update({ where: { id: projectId }, data: { status: "CONCEPT" } });
    }

    await tx.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "concept_released",
        detail: `Konzept als Version ${nextVersion} freigegeben`,
      },
    });
  });

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok(`Konzept als Version ${nextVersion} freigegeben.`);
}

/// Nimmt eine Freigabe zurueck (z.B. Korrektur noetig): Konzept zurueck auf
/// Entwurf, Projekt zurueck auf CONCEPT. Laesst laufende Tickets/Agenten
/// unangetastet, das ist bewusst ein reiner Status-Rollback.
export async function reopenConcept(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  await prisma.$transaction([
    prisma.concept.update({
      where: { projectId },
      data: { status: "DRAFT", finalizedAt: null },
    }),
    prisma.project.update({ where: { id: projectId }, data: { status: "CONCEPT" } }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "concept_reopened",
        detail: "Konzept-Freigabe zurückgezogen",
      },
    }),
  ]);

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok("Konzept-Freigabe zurückgezogen – die bisherigen Versionen bleiben erhalten.");
}
