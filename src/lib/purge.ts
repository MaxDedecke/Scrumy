// Ein Projekt loeschen heisst: Daten UND Arbeit loeschen.
//
// Die Datenbank raeumt sich beim Loeschen eines Projekts selbst auf (überall
// `onDelete: Cascade`, siehe prisma/schema.prisma). Drei Dinge haengen aber
// nicht am Fremdschluessel und bleiben sonst zurueck:
//
//  1. Das Arbeitsverzeichnis im Workspace-Volume – die Software, die das Team
//     gebaut hat. Sie liegt im Dateisystem, nicht in der DB.
//  2. Wartende Jobs in der Queue. Ein eingereihter Job laeuft nach dem
//     Loeschen noch an, legt sein Repo neu an und scheitert dann – er wuerde
//     also genau das Verzeichnis wiederherstellen, das gerade weg sollte.
//  3. Die Agenten des Teams. `Agent` haengt nur ueber `AgentAssignment` am
//     Projekt; geloescht wird die Zuordnung, die Person bleibt als Zeile ohne
//     Projekt liegen.
//
// Diese drei Reste sind der Grund fuer dieses Modul: Die Server Actions rufen
// `stopProjectWork` VOR dem Loeschen und `purgeProjectRemains` DANACH auf.
import { prisma } from "@/lib/prisma";
import { killPreviewIfRunning } from "@/lib/preview";
import { removeWorkspace } from "@/lib/workspace";
import { cancelAgentJobs } from "../../worker/queue";

export interface ProjectToPurge {
  id: string;
  workspacePath: string | null;
}

/// Nimmt die wartende Arbeit der betroffenen Teams aus der Queue und beendet
/// eine laufende Frontend-Vorschau (siehe src/lib/preview.ts). Vor dem
/// Loeschen, damit weder ein Job noch ein Vorschau-Prozess auf ein
/// Arbeitsverzeichnis zugreift, das gleich verschwindet.
export async function stopProjectWork(projectIds: string[]): Promise<number> {
  if (projectIds.length === 0) return 0;

  await Promise.all(projectIds.map((id) => killPreviewIfRunning(id)));

  const assignments = await prisma.agentAssignment.findMany({
    where: { projectId: { in: projectIds } },
    select: { agentId: true },
  });

  return cancelAgentJobs([...new Set(assignments.map((assignment) => assignment.agentId))]);
}

export interface PurgeResult {
  /// Arbeitsverzeichnisse, die nicht geloescht werden konnten (Rechte, Volume
  /// nicht eingebunden). Die Oberflaeche sagt das offen – ein stiller
  /// Fehlschlag hier hiesse: Der Kunde denkt, sein Code ist weg, und er liegt
  /// weiter auf der Platte.
  failedWorkspaces: string[];
  removedAgents: number;
}

/// Nach dem Loeschen: Arbeitsverzeichnisse wegwerfen und die Agenten
/// aufloesen, die dadurch kein Projekt mehr haben.
export async function purgeProjectRemains(projects: ProjectToPurge[]): Promise<PurgeResult> {
  const failedWorkspaces: string[] = [];

  for (const project of projects) {
    try {
      await removeWorkspace(project.id, project.workspacePath);
    } catch (error) {
      console.error(`[purge] Arbeitsverzeichnis von ${project.id} nicht geloescht:`, error);
      failedWorkspaces.push(project.workspacePath ?? project.id);
    }
  }

  const removedAgents = await deleteUnassignedAgents();
  return { failedWorkspaces, removedAgents };
}

/// Agenten ohne jede Projektzuordnung. Agenten werden pro Projekt eingestellt
/// (siehe src/lib/team.ts), also ist eine Zeile ohne Zuordnung immer ein Rest
/// eines geloeschten Projekts – kein Mensch legt Agenten auf Vorrat an. Die
/// Zuordnung entsteht zusammen mit dem Agenten in einem Schreibvorgang, es gibt
/// also kein Zeitfenster, in dem ein neuer Agent kurz "unzugeordnet" aussieht.
export async function deleteUnassignedAgents(): Promise<number> {
  const orphans = await prisma.agent.findMany({
    where: { assignments: { none: {} } },
    select: { id: true },
  });
  if (orphans.length === 0) return 0;

  const ids = orphans.map((agent) => agent.id);
  // Erst die Queue, dann die Zeilen: Ein Job auf einen geloeschten Agenten
  // wuerde beim Anlaufen nur mit einem Fehler enden.
  await cancelAgentJobs(ids);

  const { count } = await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  return count;
}
