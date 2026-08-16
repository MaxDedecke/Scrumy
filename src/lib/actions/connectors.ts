"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { ConnectorProvider, ConnectorStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

function parseConfig(raw: string | null): object | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Kein gültiges JSON -> als einzelnes Notiz-Feld ablegen statt zu verwerfen.
    return { note: raw };
  }
}

function revalidateFor(organizationId: string, projectId: string | null) {
  revalidatePath(`/organizations/${organizationId}/inbox`);
  if (projectId) revalidatePath(`/projects/${projectId}/team`);
}

export async function createConnector(formData: FormData) {
  const organizationId = str(formData, "organizationId");
  const name = str(formData, "name");
  const provider = str(formData, "provider") as ConnectorProvider | null;
  if (!organizationId || !name || !provider) return;

  const projectId = str(formData, "projectId");

  await prisma.connector.create({
    data: {
      organizationId,
      projectId,
      name,
      provider,
      credentialRef: str(formData, "credentialRef"),
      config: parseConfig(str(formData, "config")),
    },
  });

  revalidateFor(organizationId, projectId);
}

export async function updateConnectorStatus(formData: FormData) {
  const id = str(formData, "id");
  const organizationId = str(formData, "organizationId");
  const projectId = str(formData, "projectId");
  const status = str(formData, "status") as ConnectorStatus | null;
  if (!id || !organizationId || !status) return;

  await prisma.connector.update({ where: { id }, data: { status } });
  revalidateFor(organizationId, projectId);
}

export async function deleteConnector(formData: FormData) {
  const id = str(formData, "id");
  const organizationId = str(formData, "organizationId");
  const projectId = str(formData, "projectId");
  if (!id || !organizationId) return;

  await prisma.connector.delete({ where: { id } });
  revalidateFor(organizationId, projectId);
}
