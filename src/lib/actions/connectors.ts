"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CONNECTOR_STATUS_LABEL } from "@/lib/labels";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import type { ConnectorProvider, ConnectorStatus } from "@/generated/prisma/client";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

function parseConfig(raw: string | null): { config: object | undefined; fellBackToNote: boolean } {
  if (!raw) return { config: undefined, fellBackToNote: false };
  try {
    return { config: JSON.parse(raw), fellBackToNote: false };
  } catch {
    // Kein gültiges JSON -> als einzelnes Notiz-Feld ablegen statt zu verwerfen.
    return { config: { note: raw }, fellBackToNote: true };
  }
}

function revalidateFor(organizationId: string, projectId: string | null) {
  revalidatePath(`/organizations/${organizationId}/inbox`);
  if (projectId) revalidatePath(`/projects/${projectId}/team`);
}

export async function createConnector(formData: FormData): Promise<ActionResult> {
  const organizationId = str(formData, "organizationId");
  const name = str(formData, "name");
  const provider = str(formData, "provider") as ConnectorProvider | null;
  if (!organizationId) return fail("Kein Kunde angegeben.");
  if (!name || !provider) return fail("Name und Anbieter sind Pflichtfelder.");

  const projectId = str(formData, "projectId");
  const { config, fellBackToNote } = parseConfig(str(formData, "config"));

  await prisma.connector.create({
    data: {
      organizationId,
      projectId,
      name,
      provider,
      credentialRef: str(formData, "credentialRef"),
      config,
    },
  });

  revalidateFor(organizationId, projectId);
  return ok(
    `Connector „${name}“ angelegt (${projectId ? "nur dieses Projekt" : "kundenweit"}).` +
      (fellBackToNote ? " Die Config war kein gültiges JSON und wurde als Notiz abgelegt." : ""),
  );
}

export async function updateConnectorStatus(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const organizationId = str(formData, "organizationId");
  const projectId = str(formData, "projectId");
  const status = str(formData, "status") as ConnectorStatus | null;
  if (!id || !organizationId) return fail("Kein Connector angegeben.");
  if (!status) return fail("Kein Status ausgewählt.");

  const connector = await prisma.connector.update({ where: { id }, data: { status } });
  revalidateFor(organizationId, projectId);
  return ok(`„${connector.name}“ steht jetzt auf ${CONNECTOR_STATUS_LABEL[status]}.`);
}

export async function deleteConnector(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const organizationId = str(formData, "organizationId");
  const projectId = str(formData, "projectId");
  if (!id || !organizationId) return fail("Kein Connector angegeben.");

  const connector = await prisma.connector.delete({ where: { id } });
  revalidateFor(organizationId, projectId);
  return ok(`Connector „${connector.name}“ gelöscht.`);
}
