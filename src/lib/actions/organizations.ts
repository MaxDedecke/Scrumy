"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { purgeProjectRemains, stopProjectWork } from "@/lib/purge";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createOrganization(formData: FormData): Promise<ActionResult> {
  const name = str(formData, "name");
  if (!name) return fail("Bitte einen Namen für den Kunden angeben.");

  await prisma.organization.create({
    data: { name, industry: str(formData, "industry") },
  });

  revalidatePath("/");
  return ok(`Kunde „${name}“ angelegt.`);
}

export async function updateOrganization(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!id) return fail("Kein Kunde angegeben.");
  if (!name) return fail("Der Name darf nicht leer sein.");

  await prisma.organization.update({
    where: { id },
    data: { name, industry: str(formData, "industry") },
  });

  revalidatePath("/");
  return ok(`Kunde „${name}“ gespeichert.`);
}

// Kein `redirect()` in der Action: Die Oberfläche navigiert selbst, nachdem sie
// die Erfolgsmeldung angezeigt hat (siehe <ActionForm>).
export async function deleteOrganization(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  if (!id) return fail("Kein Kunde angegeben.");

  // Die Projekte müssen VOR dem Löschen gelesen werden: Der Kunde nimmt sie per
  // Cascade mit, und ohne ihre Pfade wüsste danach niemand mehr, welche
  // Repositories im Volume aufzuräumen sind.
  const projects = await prisma.project.findMany({
    where: { organizationId: id },
    select: { id: true, workspacePath: true },
  });

  await stopProjectWork(projects.map((project) => project.id));
  const organization = await prisma.organization.delete({ where: { id } });
  const purged = await purgeProjectRemains(projects);

  revalidatePath("/");
  const hint = purged.failedWorkspaces.length > 0
    ? ` Achtung: ${purged.failedWorkspaces.length} Arbeitsverzeichnis(se) konnten nicht gelöscht werden – der Code liegt noch im Volume.`
    : "";
  return ok(`Kunde „${organization.name}“ mit allen Projekten und deren Software gelöscht.${hint}`, "/");
}
