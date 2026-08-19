// Aufräumen nach einem Absturz.
//
// Wird ein Worker mitten in einem Agenten-Schritt beendet (Container-Neustart,
// OOM), bleibt in der Datenbank ein `AgentRun` auf RUNNING und der Agent auf
// WORKING stehen. Im Team-Büro sähe es dann so aus, als arbeite ein Kollege
// seit Stunden an derselben Sache – die Live-Ansicht wäre eine Lüge.
//
// Deshalb räumt jeder Worker beim Start auf: Läufe, die älter sind als jede
// legitime Laufzeit, werden als abgebrochen markiert. Die großzügige Schwelle
// ist Absicht – bei mehreren Worker-Replicas darf ein frisch gestarteter
// Prozess niemals einen Lauf abräumen, der bei einem anderen gerade läuft.
import { prisma } from "@/lib/prisma";
import { listWorkspaceProjectIds, removeWorkspace } from "@/lib/workspace";
import { deleteUnassignedAgents } from "@/lib/purge";
import { reconcileOrphanPreviewContainers } from "@/lib/preview";
import { reconcileOrphanLiveStacks } from "@/lib/liveStack";
import { cancelJobsOfDeletedAgents, unlockStaleJobs } from "./queue";
import { openClarification } from "./clarification";

/// Deutlich über dem längsten Zeitlimit eines Modellaufrufs (15 Minuten für
/// Umsetzungsschritte, siehe worker/tasks/ticketWork.ts).
const STALE_AFTER_MS = 60 * 60 * 1000;

/// Schwelle für die interaktive Variante unten (`reconcileStaleLocksNow`) –
/// deutlich enger als `STALE_AFTER_MS`, bewusst mit einem kleinen Risiko
/// falscher Treffer: Ein Ticket, das legitim laenger als 20 Minuten braucht
/// (Umsetzung + QA-Review + automatische Pruefung mehrerer Check-Ziele),
/// existiert, ist aber selten. Trifft die Schwelle trotzdem daneben und ein
/// zweiter Job startet neben einem noch laufenden, ist das seit dem
/// Workspace-Lock (worker/workspaceLock.ts) nur noch verschwendete statt
/// zerstoerender Arbeit – die beiden teilen sich das Arbeitsverzeichnis nicht
/// mehr gleichzeitig. Nur fuer den Menschen gedacht, der aktiv nachschaut
/// (siehe nudgeTeam/nudgeProductOwner in src/lib/actions/team.ts); der
/// unbeaufsichtigte stuendliche Lauf bleibt bei der vorsichtigeren
/// `STALE_AFTER_MS`.
const INTERACTIVE_STALE_AFTER_MS = 20 * 60 * 1000;

/// Zweite Sicherung fuer geloeschte Projekte: Arbeitsverzeichnisse ohne
/// Projektzeile wegwerfen.
///
/// Das Loeschen selbst passiert in der Server Action (src/lib/purge.ts). Die
/// braucht aber zwei Schritte – Datenbank und Dateisystem – und zwischen beiden
/// kann der App-Container sterben. Ohne diesen Durchlauf lebte die Software
/// eines geloeschten Kunden dann unbemerkt im Volume weiter.
///
/// Sicher gegen ein Loeschen zur falschen Zeit: Verzeichnisse sind nach der
/// Projekt-ID benannt, und die Projektzeile existiert immer schon, bevor
/// `ensureRepo` das Verzeichnis anlegt. Kein Verzeichnis ist also "noch nicht"
/// in der Datenbank – fehlt die Zeile, ist sie geloescht.
export async function reconcileOrphanWorkspaces(): Promise<number> {
  const dirIds = await listWorkspaceProjectIds();
  const known = await prisma.project.findMany({
    where: { id: { in: dirIds } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((project) => project.id));
  const orphans = dirIds.filter((id) => !knownIds.has(id));

  for (const id of orphans) {
    await removeWorkspace(id);
    console.log(`[worker] Verwaistes Arbeitsverzeichnis geloescht: ${id}`);
  }

  // Aus demselben Grund koennen Agenten ohne Projekt liegengeblieben sein.
  const agents = await deleteUnassignedAgents();
  if (agents > 0) console.log(`[worker] ${agents} Agenten ohne Projekt aufgeloest.`);

  // Erst die Sperren toter Worker loesen, sonst waeren genau die Jobs eines
  // abgestuerzten Containers vom naechsten Schritt ausgenommen.
  const unlocked = await unlockStaleJobs(STALE_AFTER_MS);
  if (unlocked > 0) console.log(`[worker] Sperren von ${unlocked} toten Worker-Pools geloest.`);

  // Und Jobs, deren Agent schon weg ist – siehe cancelJobsOfDeletedAgents.
  const jobs = await cancelJobsOfDeletedAgents();
  if (jobs > 0) console.log(`[worker] ${jobs} Jobs geloeschter Agenten aus der Queue genommen.`);

  // Und Vorschau-Container, deren Projekt schon weg ist – siehe
  // reconcileOrphanPreviewContainers.
  const previews = await reconcileOrphanPreviewContainers();
  if (previews > 0) console.log(`[worker] ${previews} verwaiste Vorschau-Container entfernt.`);

  // Und Live-Anwendungs-Stacks, deren Projekt schon weg ist – siehe
  // reconcileOrphanLiveStacks.
  const liveStacks = await reconcileOrphanLiveStacks();
  if (liveStacks > 0) console.log(`[worker] ${liveStacks} verwaiste Live-Stacks entfernt.`);

  return orphans.length;
}

export async function reconcileStaleRuns(staleAfterMs: number = STALE_AFTER_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);

  const stale = await prisma.agentRun.findMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    select: { id: true, agentId: true, projectId: true, ticketId: true, sprintId: true, headline: true },
  });
  if (stale.length === 0) return 0;

  const now = new Date();
  await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { id: { in: stale.map((run) => run.id) } },
      data: {
        status: "FAILED",
        error: "Der Worker wurde beendet, während dieser Schritt lief – Ergebnis unbekannt.",
        finishedAt: now,
      },
    }),
    prisma.agent.updateMany({
      where: {
        id: { in: stale.map((run) => run.agentId).filter((id): id is string => Boolean(id)) },
        status: "WORKING",
      },
      data: { status: "IDLE" },
    }),
    prisma.activityLogEntry.createMany({
      data: stale.map((run) => ({
        projectId: run.projectId,
        agentId: run.agentId,
        actor: "Scrumy",
        action: "step_abandoned",
        detail: `Abgebrochener Schritt aufgeräumt: ${run.headline}`,
      })),
    }),
  ]);

  // Aufräumen allein reicht nicht: Der Job zu diesem Schritt ist mit dem
  // Worker gestorben, also arbeitet hier niemand mehr weiter. Für jedes
  // betroffene aktive Projekt beruft Scrumy deshalb eine Klärung ein – ohne
  // Agenda-Vorbereitung, damit ein Neustart nicht gleich eine Welle von
  // Modellaufrufen auslöst.
  for (const run of stale) {
    const project = await prisma.project.findUnique({
      where: { id: run.projectId },
      select: { status: true },
    });
    if (project?.status !== "ACTIVE") continue;

    await openClarification({
      projectId: run.projectId,
      scope: run.ticketId ? "TICKET" : "PROJECT",
      trigger: "step_abandoned",
      ticketId: run.ticketId,
      sprintId: run.sprintId,
      raisedById: run.agentId,
      question: `Ein Schritt wurde durch einen Neustart abgebrochen: „${run.headline}". Soll das Team ihn wiederholen?`,
      context:
        "Der Worker wurde beendet, während dieser Schritt lief – ob er etwas verändert hat, ist nicht belegt. " +
        "Ein Blick in die Nachweise (Commits des Tages) zeigt, wie weit er gekommen war.",
      prepare: false,
    });
  }

  return stale.length;
}

/// Interaktives Gegenstück zum stündlichen Aufräumen oben – aufgerufen genau
/// in dem Moment, in dem ein Mensch von Hand nachschaut ("Macht weiter"/"PO
/// anstupsen", siehe src/lib/actions/team.ts), statt erst bis zu einer Stunde
/// auf den nächsten planmäßigen Durchlauf zu warten. Nutzt die engere
/// `INTERACTIVE_STALE_AFTER_MS`-Schwelle (siehe Kommentar dort) – genau
/// dieses Zusammenspiel hat iPhoto lahmgelegt: ein Container-Neustart mitten
/// im Ticket-Job hinterließ eine tote Sperre, die die ganze Warteschlange
/// dieses Agenten blockierte, und weder „Macht weiter" noch „PO anstupsen"
/// konnten das vorher beheben – beide reihen nur Jobs ein, keiner löst
/// Sperren.
export async function reconcileStaleLocksNow(): Promise<{ unlockedPools: number; abandonedRuns: number }> {
  const unlockedPools = await unlockStaleJobs(INTERACTIVE_STALE_AFTER_MS);
  const abandonedRuns = await reconcileStaleRuns(INTERACTIVE_STALE_AFTER_MS);
  return { unlockedPools, abandonedRuns };
}
