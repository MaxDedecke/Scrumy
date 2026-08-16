"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { findConceptTemplate, renderConceptTemplate } from "@/lib/conceptTemplates";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Speichert den Konzept-Entwurf (Freitext). Setzt bei Bedarf den Projekt-Status
/// von DISCOVERY auf CONCEPT, sobald zum ersten Mal am Konzept gearbeitet wird.
export async function saveConceptDraft(formData: FormData) {
  const projectId = str(formData, "projectId");
  const content = String(formData.get("content") ?? "");
  if (!projectId) return;

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
}

/// Fuellt das Konzept mit einer Vorlage vor ("baut mir ein eigenes <SaaS>").
/// Ueberschreibt einen vorhandenen Entwurf bewusst komplett – die Bestaetigung
/// dafuer holt die Oberflaeche ein. Ein freigegebenes Konzept bleibt
/// unangetastet, sonst waere die Freigabe wertlos.
export async function applyConceptTemplate(formData: FormData) {
  const projectId = str(formData, "projectId");
  const templateId = str(formData, "templateId");
  if (!projectId || !templateId) return;

  const template = findConceptTemplate(templateId);
  if (!template) return;

  const existing = await prisma.concept.findUnique({ where: { projectId } });
  if (existing?.status === "FINALIZED") return;

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
        detail: `Konzept-Vorlage „${template.name}" eingefügt`,
      },
    });
  });

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
}

/// Gibt das Konzept frei und startet damit das Agenten-Team: Projekt springt
/// auf ACTIVE. Ab hier arbeitet das Team laut Scrum-Board (`/projects/[id]`).
export async function finalizeConceptAndStartTeam(formData: FormData) {
  const projectId = str(formData, "projectId");
  if (!projectId) return;

  const concept = await prisma.concept.findUnique({ where: { projectId } });
  if (!concept || concept.content.trim().length === 0) return;

  await prisma.$transaction([
    prisma.concept.update({
      where: { projectId },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    }),
    prisma.project.update({ where: { id: projectId }, data: { status: "ACTIVE" } }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "concept_finalized",
        detail: "Konzept freigegeben – Agenten-Team gestartet",
      },
    }),
  ]);

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
}

/// Nimmt eine Freigabe zurueck (z.B. Korrektur noetig): Konzept zurueck auf
/// Entwurf, Projekt zurueck auf CONCEPT. Laesst laufende Tickets/Agenten
/// unangetastet, das ist bewusst ein reiner Status-Rollback.
export async function reopenConcept(formData: FormData) {
  const projectId = str(formData, "projectId");
  if (!projectId) return;

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
}
