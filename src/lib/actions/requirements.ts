"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { chat, extractJsonArray, LlmError } from "@/lib/llm";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import type { Priority } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Legt eine Anforderung an – entweder manuell (Titel/Beschreibung Pflicht)
/// oder per Datei-Upload (Titel optional, faellt sonst auf den Dateinamen
/// zurueck). Beides gemischt in einem Formular, weil Kunden oft beides liefern.
export async function createRequirement(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const title = str(formData, "title");
  const description = str(formData, "description");
  const priority = (str(formData, "priority") as Priority) ?? "MEDIUM";
  const file = formData.get("file");
  const hasFile = file instanceof File && file.size > 0;

  if (!title && !hasFile) return fail("Bitte einen Titel angeben oder eine Datei auswählen.");

  let savedTitle: string;
  if (hasFile) {
    const uploaded = file as File;
    const buffer = Buffer.from(await uploaded.arrayBuffer());
    savedTitle = title ?? uploaded.name;
    await prisma.requirement.create({
      data: {
        projectId,
        title: savedTitle,
        description,
        priority,
        source: "UPLOAD",
        fileName: uploaded.name,
        fileType: uploaded.type || null,
        fileData: buffer,
      },
    });
  } else {
    savedTitle = title!;
    await prisma.requirement.create({
      data: {
        projectId,
        title: savedTitle,
        description,
        priority,
        source: "MANUAL",
      },
    });
  }

  const approvalCleared = await clearRequirementsApproval(projectId);
  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok(
    `Anforderung „${savedTitle}“ gespeichert.` +
      (approvalCleared ? " Die bisherige Freigabe der Anforderungen wurde damit aufgehoben." : ""),
  );
}

/// Jede Aenderung an der Liste macht eine bestehende Freigabe ungueltig – sonst
/// wuerde der "Team starten"-Button auf eine Liste zeigen, die so nie jemand
/// geprueft hat. Gibt zurueck, ob tatsaechlich eine Freigabe aufgehoben wurde,
/// damit die Meldung das erwaehnen kann.
async function clearRequirementsApproval(projectId: string): Promise<boolean> {
  const { count } = await prisma.project.updateMany({
    where: { id: projectId, requirementsApprovedAt: { not: null } },
    data: { requirementsApprovedAt: null },
  });
  return count > 0;
}

/// Bestaetigt die Anforderungsliste als vollstaendig. Zusammen mit einem
/// freigegebenen Konzept ist das die Voraussetzung fuer "Team starten".
export async function approveRequirements(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const count = await prisma.requirement.count({ where: { projectId } });
  if (count === 0) return fail("Es gibt noch keine Anforderungen, die freigegeben werden könnten.");

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: { requirementsApprovedAt: new Date() },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Mensch",
        action: "requirements_approved",
        detail: `${count} Anforderung${count === 1 ? "" : "en"} freigegeben`,
      },
    }),
  ]);

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok(`${count} Anforderung${count === 1 ? "" : "en"} freigegeben.`);
}

/// Zieht die Freigabe der Anforderungen zurueck, um weiter zu ergaenzen.
export async function reopenRequirements(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  await clearRequirementsApproval(projectId);
  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok("Freigabe der Anforderungen zurückgezogen – die Liste lässt sich wieder ergänzen.");
}

const GENERATE_SYSTEM_PROMPT = [
  "Du bist der Product-Owner-Agent einer Softwareberatung.",
  "Du liest ein Projektkonzept und leitest daraus die Anforderungen ab, die das Entwicklungsteam umsetzen muss.",
  "Antworte ausschließlich mit einem JSON-Array, ohne Fließtext davor oder danach.",
  "Jedes Element hat die Felder: title (kurz, umsetzbar, deutsch), description (1–3 Sätze, was fachlich passieren muss),",
  'priority (genau einer der Werte "LOW", "MEDIUM", "HIGH", "URGENT").',
  "Schneide jede Anforderung so zu, dass ein Entwicklungsteam sie in wenigen Tagen umsetzen kann.",
  "Erfinde nichts, was nicht im Konzept steht oder sich zwingend daraus ergibt.",
].join(" ");

/// Leitet Anforderungen per LLM aus dem Konzept ab. Nutzt das Standard-Profil
/// aus den globalen LLM-Einstellungen. Bestehende Anforderungen bleiben
/// unangetastet – generierte kommen dazu und sind an `source = GENERATED`
/// erkennbar, damit der Mensch sie prüfen kann.
export async function generateRequirementsFromConcept(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { concept: true, organization: true },
  });
  if (!project) return fail("Projekt nicht gefunden.");

  const concept = project.concept?.content?.trim() ?? "";
  if (concept.length < 40) {
    return fail("Das Konzept ist noch zu kurz – erst ausformulieren oder eine Vorlage einfügen.");
  }

  const profile = await prisma.llmProfile.findFirst({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
  if (!profile) {
    return fail("Kein LLM-Profil angelegt (Einstellungen → LLM-Profile).");
  }

  const existing = await prisma.requirement.findMany({
    where: { projectId },
    select: { title: true },
  });

  const prompt = [
    `Kunde: ${project.organization.name}`,
    `Projekt: ${project.name}`,
    existing.length > 0
      ? `Bereits erfasste Anforderungen (nicht wiederholen): ${existing.map((r) => r.title).join("; ")}`
      : "Bisher sind keine Anforderungen erfasst.",
    "",
    "Konzept:",
    concept,
  ].join("\n");

  let answer: string;
  try {
    answer = await chat({ profile, system: GENERATE_SYSTEM_PROMPT, prompt });
  } catch (error) {
    const message = error instanceof LlmError ? error.message : String(error);
    return fail(`Profil „${profile.name}“: ${message}`);
  }

  let items: unknown[];
  try {
    items = extractJsonArray(answer);
  } catch (error) {
    return fail(error instanceof LlmError ? error.message : String(error));
  }

  const priorities: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
  const parsed = items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return [];
    const description =
      typeof record.description === "string" && record.description.trim().length > 0
        ? record.description.trim()
        : null;
    const raw = typeof record.priority === "string" ? record.priority.toUpperCase() : "";
    const priority = (priorities as string[]).includes(raw) ? (raw as Priority) : "MEDIUM";
    return [{ projectId, title, description, priority, source: "GENERATED" as const }];
  });

  if (parsed.length === 0) {
    return fail("Das Modell hat keine verwertbaren Anforderungen geliefert.");
  }

  await prisma.$transaction([
    prisma.requirement.createMany({ data: parsed }),
    prisma.project.update({ where: { id: projectId }, data: { requirementsApprovedAt: null } }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        actor: "Product-Owner-Agent",
        action: "requirements_generated",
        detail: `${parsed.length} Anforderungen aus dem Konzept abgeleitet (${profile.name})`,
      },
    }),
  ]);

  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);

  return ok(
    `${parsed.length} Anforderung${parsed.length === 1 ? "" : "en"} erzeugt mit „${profile.name}“. Bitte prüfen.`,
  );
}

export async function deleteRequirement(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const projectId = str(formData, "projectId");
  if (!id || !projectId) return fail("Keine Anforderung angegeben.");

  const requirement = await prisma.requirement.delete({ where: { id } });
  const approvalCleared = await clearRequirementsApproval(projectId);
  revalidatePath(`/projects/${projectId}/discovery`);
  revalidatePath(`/projects/${projectId}`);
  return ok(
    `Anforderung „${requirement.title}“ entfernt.` +
      (approvalCleared ? " Die bisherige Freigabe wurde damit aufgehoben." : ""),
  );
}
