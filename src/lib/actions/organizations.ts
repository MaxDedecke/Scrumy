"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createOrganization(formData: FormData) {
  const name = str(formData, "name");
  if (!name) return;

  await prisma.organization.create({
    data: { name, industry: str(formData, "industry") },
  });

  revalidatePath("/");
}

export async function updateOrganization(formData: FormData) {
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!id || !name) return;

  await prisma.organization.update({
    where: { id },
    data: { name, industry: str(formData, "industry") },
  });

  revalidatePath("/");
}

export async function deleteOrganization(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  await prisma.organization.delete({ where: { id } });
  revalidatePath("/");
  redirect("/");
}
