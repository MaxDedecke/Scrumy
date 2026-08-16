"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { LlmProvider } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function createLlmProfile(formData: FormData) {
  const name = str(formData, "name");
  const provider = str(formData, "provider") as LlmProvider | null;
  const model = str(formData, "model");
  if (!name || !provider || !model) return;

  const isDefault = formData.get("isDefault") === "on";
  if (isDefault) {
    await prisma.llmProfile.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  await prisma.llmProfile.create({
    data: {
      name,
      provider,
      model,
      baseUrl: str(formData, "baseUrl"),
      apiKeyRef: str(formData, "apiKeyRef"),
      isDefault,
    },
  });

  revalidatePath("/settings/llm-profiles");
}

export async function updateLlmProfile(formData: FormData) {
  const id = str(formData, "id");
  const name = str(formData, "name");
  const provider = str(formData, "provider") as LlmProvider | null;
  const model = str(formData, "model");
  if (!id || !name || !provider || !model) return;

  const isDefault = formData.get("isDefault") === "on";
  if (isDefault) {
    await prisma.llmProfile.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  await prisma.llmProfile.update({
    where: { id },
    data: {
      name,
      provider,
      model,
      baseUrl: str(formData, "baseUrl"),
      apiKeyRef: str(formData, "apiKeyRef"),
      isDefault,
    },
  });

  revalidatePath("/settings/llm-profiles");
}

export async function deleteLlmProfile(formData: FormData) {
  const id = str(formData, "id");
  if (!id) return;

  // Agenten, die dieses Profil nutzen, verlieren die Zuweisung (onDelete: SetNull)
  // statt dass der Agent mitgelöscht wird.
  await prisma.llmProfile.delete({ where: { id } });
  revalidatePath("/settings/llm-profiles");
}
