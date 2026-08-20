"use server";

// „Bug melden" – der Auftraggeber sieht eine fehlgeschlagene Vorschau oder
// Live-Anwendung (siehe src/app/projects/[projectId]/preview/page.tsx bzw.
// .../live/page.tsx, jeweils im ERROR-Zweig) und meldet sie direkt als
// Ticket, statt dass jemand von außen (oder wir selbst) am Kunden-Repo
// vorbeischraubt. Der Fehler landet damit dort, wo das Team ihn auch sonst
// abarbeitet – mit Nachweis, Sprint-Zuordnung und (falls nötig) menschlichem
// Review vor dem nächsten Deploy.
//
// Bewusst KEIN SupportRequest+Sprint-Planung wie bei Kundenanfragen
// (worker/tasks/sprintPlanning.ts): dort triagiert ein LLM erst noch, ob und
// wie aus einer Anfrage ein Ticket wird – hier hat der Mensch schon triagiert,
// er meldet einen konkreten, reproduzierbaren Fehler mit Log. Das wird sofort
// ein BUG-Ticket, dringend und kritisch (menschliches Review vor Abschluss).
//
// Diagnose (Fehlermeldung + Log-Ausschnitt) kommt automatisch aus
// getPreviewInfo/getLiveStackInfo mit (siehe ReportBugForm) – der Agent muss
// nicht raten, was kaputt ist.
import { prisma } from "@/lib/prisma";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { scheduleNextStep } from "@/lib/nextStep";
import { revalidateProject } from "@/lib/actions/revalidate";
import { reconcileStaleLocksNow } from "../../../worker/reconcile";
import { revalidatePath } from "next/cache";

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

const SOURCE_LABEL: Record<string, string> = {
  live: "Live-Anwendung",
  preview: "Vorschau",
};

export async function reportBug(formData: FormData): Promise<ActionResult> {
  const projectId = str(formData, "projectId");
  if (!projectId) return fail("Kein Projekt angegeben.");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return fail("Projekt nicht gefunden.");

  const sourceLabel = SOURCE_LABEL[str(formData, "source") ?? ""] ?? "Anwendung";
  const note = str(formData, "note");
  const diagnostics = str(formData, "diagnostics");
  if (!note && !diagnostics) return fail("Nichts zu melden – keine Fehlermeldung und keine eigene Beschreibung.");

  const title = `Bug: ${note ? note.slice(0, 80) : `${sourceLabel} lässt sich nicht starten`}`;
  const description = [
    note ?? `${sourceLabel} lässt sich beim Testen nicht starten.`,
    diagnostics ? `## Fehlermeldung beim Testen (${sourceLabel})\n${diagnostics}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // In den laufenden Sprint, falls es einen gibt – sonst zieht ihn die
  // nächste Sprint-Planung als Backlog-Ticket automatisch (dieselbe Regel wie
  // für per Klärungs-Beschluss zurückgestellte Tickets, siehe dort).
  const openSprint = await prisma.sprint.findFirst({
    where: { projectId, status: { not: "DONE" } },
    orderBy: { number: "desc" },
  });

  const ticket = await prisma.ticket.create({
    data: {
      projectId,
      sprintId: openSprint?.id ?? null,
      title,
      description,
      type: "BUG",
      priority: "URGENT",
      isCritical: true,
      requestedBy: "Auftraggeber (Bug-Meldung)",
    },
  });

  await prisma.activityLogEntry.create({
    data: {
      projectId,
      ticketId: ticket.id,
      actor: "Mensch",
      action: "bug_reported",
      detail:
        `Fehler gemeldet: „${title}"` +
        (openSprint ? ` – direkt in Sprint ${openSprint.number} aufgenommen.` : " – kommt in den nächsten Sprint."),
    },
  });

  revalidateProject(projectId);
  revalidatePath(`/projects/${projectId}/live`);

  if (project.status !== "ACTIVE") {
    return ok(`Als Ticket „${title}" gemeldet. Das Team ist pausiert/beendet – wird aufgegriffen, sobald es weiterarbeitet.`);
  }

  // Dieselbe Vorab-Aufräumung + Lauf-Prüfung wie beim „Macht weiter"-Knopf
  // (nudgeTeam in team.ts): eine tote Job-Sperre soll das Melden nicht
  // zusätzlich blockieren, und läuft schon etwas, holt sich das Team das neue
  // Ticket von allein, sobald es dran ist.
  await reconcileStaleLocksNow();
  const running = await prisma.agentRun.findFirst({ where: { projectId, status: "RUNNING" } });
  const next = running
    ? "Das Team arbeitet gerade – das neue Ticket kommt automatisch dran."
    : await scheduleNextStep(projectId);

  return ok(`Als Ticket „${title}" gemeldet (${openSprint ? `Sprint ${openSprint.number}` : "Backlog"}, dringend). ${next}`);
}
