"use server";

// Ein einzelner Agentenlauf im Nachweise-Bereich lässt sich von Hand
// abbrechen. Die eigentliche Arbeit steckt in worker/cancellation.ts (das
// Abfrage-Signal, das ein laufender Modell-/Werkzeugaufruf beobachtet) –
// diese Action setzt nur das Flag, in dem der Wunsch über die Prozessgrenze
// zum Worker hinweg ankommt.
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import { revalidateProject } from "@/lib/actions/revalidate";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

export async function stopAgentRun(formData: FormData): Promise<ActionResult> {
  const runId = str(formData, "runId");
  if (!runId) return fail("Kein Lauf angegeben.");

  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { projectId: true, status: true, headline: true } });
  if (!run) return fail("Diesen Lauf gibt es nicht (mehr).");

  // `updateMany` mit Statusfilter statt `update`: Ist der Lauf zwischen dem
  // Laden der Seite und dem Klick schon fertig geworden, soll der Klick ins
  // Leere laufen statt einen längst abgeschlossenen Beleg zu verfälschen.
  const { count } = await prisma.agentRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { cancelRequested: true },
  });
  if (count === 0) return note("Der Lauf ist inzwischen fertig – da gibt es nichts mehr zu stoppen.");

  revalidateProject(run.projectId);
  return ok(
    `„${run.headline}" wird gestoppt – spätestens in ein paar Sekunden. Der Product Owner bekommt danach die Chance, den Schritt erneut anzustoßen.`,
  );
}
