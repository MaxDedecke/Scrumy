"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createProject(formData: FormData) {
  const organizationId = str(formData, "organizationId");
  const name = str(formData, "name");
  if (!organizationId || !name) return;

  await prisma.project.create({
    data: {
      organizationId,
      name,
      description: str(formData, "description"),
      repoUrl: str(formData, "repoUrl"),
    },
  });

  revalidatePath("/");
}

export async function updateProject(formData: FormData) {
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!id || !name) return;

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
}

export async function deleteProject(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  await prisma.project.delete({ where: { id } });
  revalidatePath("/");
  redirect("/");
}
