// Verbindet die in der Projektmaske gespeicherte Repository-URL mit der
// lokalen Git-Schicht. `Project.repoUrl` ist die kanonische URL; ein aktiver,
// projektspezifischer Git-Connector liefert optional Zielbranch und die
// Referenz auf den Token in der Worker-Umgebung.
import type { Project } from "@/generated/prisma/client";
import { configureRepoRemote, pushRepo, type RemoteRepositoryOptions } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";

function objectConfig(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function remoteSettingsForProject(
  project: Pick<Project, "id" | "repoUrl">,
): Promise<RemoteRepositoryOptions | null> {
  const connector = await prisma.connector.findFirst({
    where: { projectId: project.id, provider: "GIT", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  const config = objectConfig(connector?.config);
  const remoteUrl = project.repoUrl?.trim() || text(config.repoUrl);
  if (!remoteUrl) return null;

  return {
    remoteUrl,
    defaultBranch: text(config.defaultBranch),
    credentialRef: connector?.credentialRef?.trim() || null,
  };
}

/// Wird am Anfang jedes Arbeitsschritts aufgerufen. Dadurch greifen eine
/// nachtraeglich geaenderte URL oder ein neu angelegter Git-Connector beim
/// naechsten Schritt auch bei Bestandsprojekten. Der Push vor der eigentlichen
/// Agentenarbeit veroeffentlicht zudem lokale Commits, die nach einem frueheren
/// kurzzeitigen Netzwerkfehler noch ausstehen.
export async function prepareProjectRepository(
  project: Pick<Project, "id" | "repoUrl" | "workspacePath">,
): Promise<RemoteRepositoryOptions | null> {
  const settings = await remoteSettingsForProject(project);
  if (project.workspacePath) {
    await configureRepoRemote(project.workspacePath, settings);
    await pushRepo(project.workspacePath);
  }
  return settings;
}
