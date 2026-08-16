"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { Priority } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Legt eine Anforderung an – entweder manuell (Titel/Beschreibung Pflicht)
/// oder per Datei-Upload (Titel optional, faellt sonst auf den Dateinamen
/// zurueck). Beides gemischt in einem Formular, weil Kunden oft beides liefern.
export async function createRequirement(formData: FormData) {
  const projectId = str(formData, "projectId");
  if (!projectId) return;

  const title = str(formData, "title");
  const description = str(formData, "description");
  const priority = (str(formData, "priority") as Priority) ?? "MEDIUM";
  const file = formData.get("file");
  const hasFile = file instanceof File && file.size > 0;

  if (!title && !hasFile) return; // weder Titel noch Datei angegeben

  if (hasFile) {
    const uploaded = file as File;
    const buffer = Buffer.from(await uploaded.arrayBuffer());
    await prisma.requirement.create({
      data: {
        projectId,
        title: title ?? uploaded.name,
        description,
        priority,
        source: "UPLOAD",
        fileName: uploaded.name,
        fileType: uploaded.type || null,
        fileData: buffer,
      },
    });
  } else {
    await prisma.requirement.create({
      data: {
        projectId,
        title: title!,
        description,
        priority,
        source: "MANUAL",
      },
    });
  }

  revalidatePath(`/projects/${projectId}/discovery`);
}

export async function deleteRequirement(formData: FormData) {
  const id = str(formData, "id");
  const projectId = str(formData, "projectId");
  if (!id || !projectId) return;

  await prisma.requirement.delete({ where: { id } });
  revalidatePath(`/projects/${projectId}/discovery`);
}
