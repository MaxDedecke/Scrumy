// Verbindet die in der Projektmaske gespeicherte Repository-URL mit der
// lokalen Git-Schicht. `Project.repoUrl` ist die kanonische URL; ein aktiver,
// projektspezifischer Git-Connector liefert optional Zielbranch und die
// Referenz auf den Token in der Worker-Umgebung.
import type { Project } from "@/generated/prisma/client";
import { configureRepoRemote, pushRepo, type RemoteRepositoryOptions } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { logActivity } from "./agentRun";

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
///
/// Push-Ergebnis geht als `repo_pushed`/`repo_push_failed` ins Aktivitaetsprotokoll
/// (nur bei tatsaechlich Neuem – "Everything up-to-date" ist kein Ereignis).
/// Vorher war das komplett unsichtbar: weder ein erfolgreicher Push noch ein
/// abgelaufener PAT/Branch-Schutz tauchten irgendwo auf, und ein Fehlschlag
/// hier riss (ungefangen in `loadWorkingProject`) den GANZEN Arbeitsschritt
/// mit sich – Sprint-Planung oder Ticket-Arbeit brachen dann mit einem
/// Git-Fehler ab, der im Buero wie ein beliebiger anderer Fehlschlag aussah.
/// Jetzt bleibt ein kaputter Push ein isoliertes, sichtbares Ereignis, und das
/// Team arbeitet mit dem lokalen Repo weiter, statt komplett zu blockieren.
export async function prepareProjectRepository(
  project: Pick<Project, "id" | "repoUrl" | "workspacePath">,
): Promise<RemoteRepositoryOptions | null> {
  const settings = await remoteSettingsForProject(project);
  if (project.workspacePath) {
    try {
      await configureRepoRemote(project.workspacePath, settings);
      const result = await pushRepo(project.workspacePath);
      if (result.pushed) {
        await logActivity({
          projectId: project.id,
          actor: "Scrumy",
          action: "repo_pushed",
          detail: `Lokaler Stand nach ${settings?.remoteUrl ?? "origin"} gepusht${result.commit ? ` (${result.commit.slice(0, 7)})` : ""}.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logActivity({
        projectId: project.id,
        actor: "Scrumy",
        action: "repo_push_failed",
        detail: message,
      });
    }
  }
  return settings;
}
