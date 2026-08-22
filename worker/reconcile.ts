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
import { listWorkspaceProjectIds, removeWorkspace, runGitCommand } from "@/lib/workspace";
import { deleteUnassignedAgents } from "@/lib/purge";
import { reconcileOrphanPreviewContainers } from "@/lib/preview";
import { reconcileOrphanLiveStacks } from "@/lib/liveStack";
import { activeTicketJobIds, cancelJobsOfDeletedAgents, deadJobs, removeJobs, unlockStaleJobs } from "./queue";
import { openClarification } from "./clarification";
import { failRun, logActivity } from "./agentRun";
import { rm } from "node:fs/promises";

/// Deutlich über dem längsten Zeitlimit eines Modellaufrufs (35 Minuten für
/// Umsetzungsschritte, siehe LOOP_BUDGET_MS in worker/agentToolLoop.ts).
const STALE_AFTER_MS = 90 * 60 * 1000;

/// Schwelle für die interaktive Variante unten (`reconcileStaleLocksNow`) –
/// deutlich enger als `STALE_AFTER_MS`, bewusst mit einem kleinen Risiko
/// falscher Treffer: Ein Ticket, das legitim laenger als 45 Minuten braucht
/// (Umsetzung bis zu 35 Min. + QA-Review + automatische Pruefung mehrerer
/// Check-Ziele), existiert, ist aber selten. (22.08.2026: von 20 auf 45 Min.
/// angehoben, zusammen mit LOOP_BUDGET_MS – bei 20 Min. waere sonst JEDER
/// Anlauf, der die neue 35-Minuten-Zeiterinnerung tatsaechlich ausnutzt,
/// faelschlich als haengengeblieben markiert worden, statt nur der seltene
/// Ausreisser.) Trifft die Schwelle trotzdem daneben und ein zweiter Job
/// startet neben einem noch laufenden, ist das seit dem Workspace-Lock
/// (worker/workspaceLock.ts) nur noch verschwendete statt zerstoerender
/// Arbeit – die beiden teilen sich das Arbeitsverzeichnis nicht mehr
/// gleichzeitig. Nur fuer den Menschen gedacht, der aktiv nachschaut (siehe
/// nudgeTeam/nudgeProductOwner in src/lib/actions/team.ts); der
/// unbeaufsichtigte stuendliche Lauf bleibt bei der vorsichtigeren
/// `STALE_AFTER_MS`.
const INTERACTIVE_STALE_AFTER_MS = 45 * 60 * 1000;

/// Schonfrist fuer einen von Hand gestoppten Lauf (siehe
/// `reconcileCancelledRuns`). Hier muss nichts geraten werden: Dass niemand
/// mehr an diesem Lauf arbeitet, ist bekannt – jemand hat ihn absichtlich
/// beendet. Zwei Minuten sind reichlich Vorsprung fuer den Weg, der eigentlich
/// greifen soll (worker/cancellation.ts fragt alle 1,5 Sekunden ab, der
/// abgebrochene Aufruf schliesst sich danach selbst ab); erst wenn auch das
/// ausbleibt – weil der Worker zwischendurch gestorben ist – raeumt der
/// Sweep hinterher, statt den Lauf bis zu 2,5 Stunden als "arbeitet gerade"
/// im Buero stehen zu lassen.
const CANCELLED_GRACE_MS = 2 * 60 * 1000;

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

  // Und Ticket-Worktrees, deren Ticket laengst fertig oder deren Projekt
  // nicht mehr aktiv ist – siehe reconcileOrphanTicketWorktrees.
  const worktrees = await reconcileOrphanTicketWorktrees();
  if (worktrees > 0) console.log(`[worker] ${worktrees} verwaiste Ticket-Worktrees entfernt.`);

  return orphans.length;
}

/// Tickets, deren Git-Worktree (siehe worker/ticketWorktree.ts) liegen
/// geblieben ist, obwohl das Ticket laengst DONE ist – die Uebernahme in den
/// Hauptbranch ist gecrasht NACH dem Setzen von DONE, aber VOR dem Aufraeumen
/// des Worktrees. Bewusst NICHT an einen pausierten/archivierten Projektstatus
/// gekoppelt: Ein noch nicht fertiges Ticket in einem eigenen Worktree ist
/// legitime, unfertige Arbeit (z.B. waehrend das Projekt pausiert ist) – die
/// darf hier nicht wegräumen, was ein spaeteres Fortsetzen noch braucht.
export async function reconcileOrphanTicketWorktrees(): Promise<number> {
  const candidates = await prisma.ticket.findMany({
    where: { worktreePath: { not: null }, status: "DONE" },
    select: {
      id: true,
      worktreePath: true,
      project: { select: { workspacePath: true } },
    },
  });

  let cleaned = 0;
  for (const ticket of candidates) {
    if (!ticket.worktreePath) continue;

    if (ticket.project.workspacePath) {
      await runGitCommand(ticket.project.workspacePath, ["worktree", "remove", ticket.worktreePath, "--force"]).catch(() => {});
      await runGitCommand(ticket.project.workspacePath, ["branch", "-D", `ticket/${ticket.id}`]).catch(() => {});
    }
    // Zweite Sicherung, falls `git worktree remove` scheitert (z.B. weil das
    // Hauptverzeichnis selbst schon weg ist) – dasselbe Prinzip wie
    // `removeWorkspace`.
    await rm(ticket.worktreePath, { recursive: true, force: true });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { worktreePath: null } });
    cleaned += 1;
  }
  return cleaned;
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

/// Von Hand gestoppte Laeufe, die sich nicht selbst abgeschlossen haben.
///
/// Der normale Weg braucht diesen Sweep nicht: Der Stopp-Knopf setzt
/// `cancelRequested`, der laufende Aufruf sieht das binnen Sekunden
/// (worker/cancellation.ts) und schliesst seinen Beleg selbst ab. Faellt der
/// Worker aber genau dazwischen aus – Neustart, Rebuild, OOM –, bleibt eine
/// Zeile auf RUNNING liegen, und bis hierher fing die erst
/// `reconcileStaleRuns` auf: 90 Minuten Schwelle, stuendlich geprueft, also
/// bis zu 2,5 Stunden "arbeitet gerade" im Buero, obwohl niemand daran sitzt.
///
/// Die grosszuegige Schwelle dort ist richtig – bei einem abgestuerzten Worker
/// laesst sich nicht unterscheiden, ob der Lauf noch lebt. Hier muss aber gar
/// nicht geraten werden: Ein Mensch hat diesen Lauf absichtlich gestoppt.
/// Deshalb eine eigene, kurze Schonfrist (`CANCELLED_GRACE_MS`), ohne die
/// allgemeine Schwelle anzufassen.
export async function reconcileCancelledRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - CANCELLED_GRACE_MS);

  const stale = await prisma.agentRun.findMany({
    where: {
      status: "RUNNING",
      cancelRequested: true,
      // `cancelRequestedAt` ist der richtige Zeitpunkt; fuer Laeufe von vor
      // dieser Spalte bleibt nur `startedAt` – die sind ohnehin laengst alt.
      OR: [{ cancelRequestedAt: { lt: cutoff } }, { cancelRequestedAt: null, startedAt: { lt: cutoff } }],
    },
    select: { id: true, agentId: true, projectId: true, ticketId: true, headline: true, startedAt: true },
  });

  let cleaned = 0;
  for (const run of stale) {
    if (!run.agentId) {
      // Agent geloescht: Es gibt keinen Status mehr umzuschalten und keinen,
      // der eine Klaerung einberufen koennte – nur den Beleg abschliessen.
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: "Von Hand abgebrochen.", finishedAt: new Date() },
      });
      cleaned += 1;
      continue;
    }

    // Dieselbe Logik wie im laufenden Worker (worker/agentRun.ts): Beleg
    // abschliessen, Kollegen freigeben, Klaerung fuer den Product Owner.
    await failRun(
      run.id,
      run.agentId,
      "Von Hand abgebrochen – der Lauf hat nicht mehr selbst reagiert (Worker vermutlich zwischendurch beendet).",
      Date.now() - run.startedAt.getTime(),
      true,
    );
    await logActivity({
      projectId: run.projectId,
      agentId: run.agentId,
      ticketId: run.ticketId ?? undefined,
      actor: "Scrumy",
      action: "step_cancelled",
      detail: `${run.headline} – von Hand abgebrochen, nachträglich abgeschlossen.`,
    });
    cleaned += 1;
  }

  return cleaned;
}

/// Endgueltig gescheiterte Jobs sichtbar machen und aus der Queue nehmen.
///
/// Ein Job, dessen Anlauf-Budget verbraucht ist (`attempts >= max_attempts`,
/// siehe `deadJobs` in worker/queue.ts), laeuft nie wieder an. Er verschwindet
/// aber auch nicht: Er steht weiter in der Queue-Tabelle und sieht dort aus wie
/// ausstehende Arbeit – am 22.08.2026 lagen so vier `ticketWork`-Jobs seit dem
/// Vortag herum, zwei davon zu Tickets, die laengst DONE waren.
///
/// Verloren geht dabei nichts (das Anlauf-Budget am Ticket eskaliert eigenstaendig,
/// siehe worker/tasks/ticketWork.ts) – es fehlt nur die Sichtbarkeit. Also:
/// Was zu einem noch offenen Ticket eines aktiven Projekts gehoert, wird zur
/// Klaerung; alles andere ist eine Karteileiche und wird still entfernt.
export async function reconcileDeadJobs(): Promise<number> {
  const jobs = await deadJobs();
  if (jobs.length === 0) return 0;

  // Tickets, fuer die inzwischen wieder ein lebender Job in der Queue steht:
  // Da ist die Arbeit laengst weitergegangen (typisch nach einem Rebuild –
  // der Sprint hat das Ticket einfach neu eingereiht). Die tote Zeile ist dann
  // nur noch Muell, kein Grund, jemanden zu rufen.
  const ticketIds = jobs.map((job) => job.payload.ticketId).filter((id): id is string => Boolean(id));
  const stillQueued = await activeTicketJobIds(ticketIds);

  const removable: string[] = [];
  for (const job of jobs) {
    const ticketId = job.payload.ticketId ?? null;
    const agentId = job.payload.agentId ?? null;

    const ticket = ticketId
      ? await prisma.ticket.findUnique({
          where: { id: ticketId },
          select: { id: true, title: true, status: true, projectId: true, project: { select: { status: true } } },
        })
      : null;

    // Karteileiche (kein Ticket mehr, Ticket fertig, Projekt nicht aktiv,
    // Arbeit laeuft schon wieder) wird still entfernt; alles andere muss
    // vorher jemand zu sehen bekommen.
    if (ticket && ticket.status !== "DONE" && ticket.project.status === "ACTIVE" && !stillQueued.has(ticket.id)) {
      await logActivity({
        projectId: ticket.projectId,
        agentId: agentId ?? undefined,
        ticketId: ticket.id,
        actor: "Scrumy",
        action: "job_dead",
        detail: `Arbeitsschritt „${job.taskIdentifier}" zu „${ticket.title}" ist endgültig gescheitert und wurde aus der Warteschlange genommen.`,
      });

      // Nur einberufen, wenn zu diesem Ticket nicht ohnehin schon etwas offen
      // ist: In der Regel hat das Anlauf-Budget vorher selbst eskaliert (siehe
      // worker/tasks/ticketWork.ts), und der Mensch soll eine Frage
      // beantworten, nicht zwei zur selben Sache.
      const alreadyOpen = await prisma.clarification.findFirst({
        where: { ticketId: ticket.id, status: "OPEN" },
        select: { id: true },
      });
      if (!alreadyOpen) {
        await openClarification({
          projectId: ticket.projectId,
          scope: "TICKET",
          trigger: "job_dead",
          ticketId: ticket.id,
          raisedById: agentId,
          question: `Die Arbeit an „${ticket.title}" ist endgültig gescheitert – alle Anläufe dieses Arbeitsschritts sind verbraucht. Soll das Team es erneut versuchen?`,
          context:
            `Letzter Fehler: ${(job.lastError ?? "keiner protokolliert – der Job wurde zweimal mitten in der Arbeit unterbrochen").slice(0, 1500)}\n\n` +
            `Der Job stand seit ${job.createdAt.toISOString().slice(0, 16).replace("T", " ")} in der Warteschlange, ohne noch anlaufen zu können.`,
          prepare: false,
        });
      }
    }

    // Erst jetzt zum Loeschen vormerken: Scheitert das Sichtbarmachen oben,
    // bleibt der Job liegen und der naechste Durchlauf nimmt ihn erneut vor –
    // besser als eine still verschwundene Zeile.
    removable.push(job.id);
  }

  await removeJobs(removable);
  return removable.length;
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
export async function reconcileStaleLocksNow(): Promise<{
  unlockedPools: number;
  abandonedRuns: number;
  cancelledRuns: number;
  deadJobs: number;
}> {
  const unlockedPools = await unlockStaleJobs(INTERACTIVE_STALE_AFTER_MS);
  const abandonedRuns = await reconcileStaleRuns(INTERACTIVE_STALE_AFTER_MS);
  // Beides braucht keine Schaetzung ueber "laeuft da noch was?" und gehoert
  // deshalb genauso in den Moment, in dem ein Mensch nachschaut.
  const cancelledRuns = await reconcileCancelledRuns();
  const deadJobsRemoved = await reconcileDeadJobs();
  return { unlockedPools, abandonedRuns, cancelledRuns, deadJobs: deadJobsRemoved };
}
