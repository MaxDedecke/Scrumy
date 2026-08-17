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
import { openClarification } from "./clarification";

/// Deutlich über dem längsten Zeitlimit eines Modellaufrufs (15 Minuten für
/// Umsetzungsschritte, siehe worker/tasks/ticketWork.ts).
const STALE_AFTER_MS = 60 * 60 * 1000;

export async function reconcileStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

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
