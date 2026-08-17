"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { purgeProjectRemains, stopProjectWork } from "@/lib/purge";
import type { ProjectStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createProject(formData: FormData): Promise<ActionResult> {
  const organizationId = str(formData, "organizationId");
  const name = str(formData, "name");
  if (!organizationId) return fail("Kein Kunde angegeben.");
  if (!name) return fail("Bitte einen Namen für das Projekt angeben.");

  await prisma.project.create({
    data: {
      organizationId,
      name,
      description: str(formData, "description"),
      repoUrl: str(formData, "repoUrl"),
    },
  });

  revalidatePath("/");
  return ok(`Projekt „${name}“ angelegt.`);
}

export async function updateProject(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!id) return fail("Kein Projekt angegeben.");
  if (!name) return fail("Der Name darf nicht leer sein.");

  await prisma.project.update({
    where: { id },
    data: {
      name,
      description: str(formData, "description"),
      repoUrl: str(formData, "repoUrl"),
      status: (str(formData, "status") as ProjectStatus) ?? undefined,
    },
  });

  revalidatePath("/");
  revalidatePath(`/projects/${id}`);
  return ok(`Projekt „${name}“ gespeichert.`);
}

/// Loescht das Projekt vollstaendig: Daten, wartende Arbeit und das
/// Repository, in dem das Team die Software gebaut hat (siehe src/lib/purge.ts).
export async function deleteProject(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  if (!id) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, workspacePath: true },
  });
  if (!project) return fail("Projekt nicht gefunden.");

  await stopProjectWork([project.id]);
  await prisma.project.delete({ where: { id } });
  const purged = await purgeProjectRemains([project]);

  revalidatePath("/");
  const hint = purged.failedWorkspaces.length > 0
    ? ` Achtung: Das Arbeitsverzeichnis (${purged.failedWorkspaces.join(", ")}) konnte nicht gelöscht werden – der Code liegt noch im Volume.`
    : project.workspacePath
      ? " Das Repository mit der gebauten Software wurde mitgelöscht."
      : "";
  return ok(`Projekt „${project.name}“ gelöscht.${hint}`, "/");
}
