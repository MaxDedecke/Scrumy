"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CONNECTOR_STATUS_LABEL } from "@/lib/labels";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { gitCredentialEnvName, WorkspaceError } from "@/lib/workspace";
import { encryptSecret } from "@/lib/secret";
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

function configText(config: object | undefined, key: string): string | null {
  if (!config || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateGitCredentialRef(credentialRef: string | null): string | null {
  try {
    gitCredentialEnvName(credentialRef);
    return null;
  } catch (error) {
    return error instanceof WorkspaceError || error instanceof Error ? error.message : String(error);
  }
}

/// Ein direkt ins Formular eingegebener Token (nicht "env:NAME") wird
/// verschlüsselt gespeichert – bislang zwang jeder Connector zur `env:`-
/// Referenz, was ohne Server-/`.env`-Zugriff faktisch nicht nutzbar war.
/// `env:`-Referenzen bleiben unverändert (ihr Wert steht ohnehin nie in der
/// DB, nur im Worker). Gilt für alle Connector-Provider, nicht nur GIT – das
/// Formularfeld ist dasselbe.
function resolveCredentialRef(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("env:") || raw.startsWith("enc:")) return raw;
  return `enc:${encryptSecret(raw)}`;
}

async function activeGitConnectorExists(projectId: string, exceptId?: string): Promise<boolean> {
  return Boolean(
    await prisma.connector.findFirst({
      where: {
        projectId,
        provider: "GIT",
        status: "ACTIVE",
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    }),
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export async function createConnector(formData: FormData): Promise<ActionResult> {
  const organizationId = str(formData, "organizationId");
  const name = str(formData, "name");
  const provider = str(formData, "provider") as ConnectorProvider | null;
  if (!organizationId) return fail("Kein Kunde angegeben.");
  if (!name || !provider) return fail("Name und Anbieter sind Pflichtfelder.");

  const projectId = str(formData, "projectId");
  const { config, fellBackToNote } = parseConfig(str(formData, "config"));
  const credentialRef = str(formData, "credentialRef");

  if (provider === "GIT") {
    if (!projectId) return fail("Ein Git-Connector muss genau einem Projekt zugeordnet sein.");
    if (fellBackToNote) return fail("Die Git-Config muss gültiges JSON sein.");
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true, repoUrl: true },
    });
    if (!project || project.organizationId !== organizationId) return fail("Projekt und Kunde passen nicht zusammen.");
    if (!project.repoUrl && !configText(config, "repoUrl")) {
      return fail("Für den Git-Connector fehlt eine Repository-URL im Projekt oder in der Connector-Config.");
    }
    const credentialError = validateGitCredentialRef(credentialRef);
    if (credentialError) return fail(credentialError);
    if (await activeGitConnectorExists(projectId)) {
      return fail("Für dieses Projekt existiert bereits ein aktiver Git-Connector. Deaktiviere ihn zuerst.");
    }
  }

  try {
    await prisma.connector.create({
      data: { organizationId, projectId, name, provider, credentialRef: resolveCredentialRef(credentialRef), config },
    });
  } catch (error) {
    if (provider === "GIT" && isUniqueConstraintError(error)) {
      return fail("Für dieses Projekt existiert bereits ein aktiver Git-Connector.");
    }
    throw error;
  }

  revalidateFor(organizationId, projectId);
  return ok(
    `Connector „${name}“ angelegt (${projectId ? "nur dieses Projekt" : "kundenweit"}).` +
      (fellBackToNote ? " Die Config war kein gültiges JSON und wurde als Notiz abgelegt." : ""),
  );
}

export async function updateConnectorStatus(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  const status = str(formData, "status") as ConnectorStatus | null;
  if (!id) return fail("Kein Connector angegeben.");
  if (!status) return fail("Kein Status ausgewählt.");

  const existing = await prisma.connector.findUnique({ where: { id } });
  if (!existing) return fail("Connector nicht gefunden.");
  if (existing.provider === "GIT" && status === "ACTIVE") {
    if (!existing.projectId) return fail("Ein Git-Connector muss genau einem Projekt zugeordnet sein.");
    const credentialError = validateGitCredentialRef(existing.credentialRef);
    if (credentialError) return fail(credentialError);
    if (await activeGitConnectorExists(existing.projectId, existing.id)) {
      return fail("Für dieses Projekt existiert bereits ein anderer aktiver Git-Connector.");
    }
  }

  let connector;
  try {
    connector = await prisma.connector.update({ where: { id }, data: { status } });
  } catch (error) {
    if (existing.provider === "GIT" && isUniqueConstraintError(error)) {
      return fail("Für dieses Projekt existiert bereits ein anderer aktiver Git-Connector.");
    }
    throw error;
  }
  revalidateFor(connector.organizationId, connector.projectId);
  return ok(`„${connector.name}“ steht jetzt auf ${CONNECTOR_STATUS_LABEL[status]}.`);
}

export async function deleteConnector(formData: FormData): Promise<ActionResult> {
  const id = str(formData, "id");
  if (!id) return fail("Kein Connector angegeben.");

  const connector = await prisma.connector.delete({ where: { id } });
  revalidateFor(connector.organizationId, connector.projectId);
  return ok(`Connector „${connector.name}“ gelöscht.`);
}
