"use server";

// Der Beschluss des Auftraggebers – und was er auslöst.
//
// Eine Klärung ist erst dann etwas wert, wenn die Entscheidung das Team auch
// wieder in Bewegung setzt. Deshalb ist `decideClarification` kein
// Kommentarfeld: Sie hält den Beschluss fest (er geht ins Beschlussregister
// und damit in jeden weiteren Prompt), hängt ihn an das betroffene Ticket und
// nimmt den eingefrorenen Arbeitsschritt wieder auf. Erst dadurch entfällt der
// Griff in die Datenbank, mit dem ein hängendes Projekt bisher wiederbelebt
// werden musste.
import { prisma } from "@/lib/prisma";
import { fail, note, ok, type ActionResult } from "@/lib/actions/result";
import { revalidateProject } from "@/lib/actions/revalidate";
import { scheduleNextStep } from "@/lib/nextStep";
import { OWN_OPTION_KEY, readOptions, type ClarificationEffect } from "@/lib/clarificationOptions";
import { enqueueAgentJob } from "../../../worker/queue";
import type { ConnectorProvider, SupportChannel } from "@/generated/prisma/client";

/// Um wie viele Sprints das Budget waechst, wenn der Auftraggeber
/// weiterarbeiten laesst (siehe worker/tasks/sprintPlanning.ts).
const SPRINT_BUDGET_STEP = 6;

function str(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value.length > 0 ? value : null;
}

/// Beschluss fassen: festhalten, ans Ticket haengen, Arbeit wieder aufnehmen.
export async function decideClarification(formData: FormData): Promise<ActionResult> {
  const clarificationId = str(formData, "clarificationId");
  const optionKey = str(formData, "option");
  const comment = str(formData, "comment");
  if (!clarificationId) return fail("Keine Klärung angegeben.");

  const clarification = await prisma.clarification.findUnique({
    where: { id: clarificationId },
    include: { ticket: true },
  });
  if (!clarification) return fail("Klärung nicht gefunden.");
  if (clarification.status !== "OPEN") return note("Diese Klärung ist bereits entschieden.");

  // „Eigener Weg" ist keine gespeicherte Option, sondern das Textfeld: Dann
  // zaehlt allein, was der Mensch aufgeschrieben hat – ohne dass ihm der Titel
  // eines Vorschlags vorangestellt wird, den er gerade abgelehnt hat.
  const ownWay = optionKey === OWN_OPTION_KEY;
  const option = ownWay ? null : readOptions(clarification.options).find((entry) => entry.key === optionKey);
  if (ownWay && !comment) {
    return fail("Bitte den eigenen Weg aufschreiben – oder einen der Vorschläge auswählen.");
  }
  if (!optionKey && !comment) {
    return fail("Bitte einen Weg auswählen oder den Beschluss aufschreiben.");
  }

  const decision = [option?.label, comment].filter(Boolean).join(" – ");
  const effect: ClarificationEffect = option?.effect ?? "resume";
  const projectId = clarification.projectId;

  await prisma.$transaction([
    prisma.clarification.update({
      where: { id: clarificationId },
      data: {
        status: "DECIDED",
        decision,
        decidedBy: "Mensch",
        decidedAt: new Date(),
      },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: clarification.ticketId,
        actor: "Mensch",
        action: "clarification_decided",
        detail: `Beschluss zu „${clarification.question.slice(0, 160)}": ${decision.slice(0, 300)}`,
      },
    }),
  ]);

  // Der Beschluss gehoert auch dorthin, wo der naechste Agent ihn garantiert
  // liest: in den Plan des Tickets, an dem er weiterarbeitet.
  if (clarification.ticket) {
    await prisma.ticket.update({
      where: { id: clarification.ticket.id },
      data: {
        plan:
          `${clarification.ticket.plan ?? ""}\n\n## Beschluss des Auftraggebers\n` +
          `Frage: ${clarification.question}\nBeschluss: ${decision}`,
      },
    });
  }

  // Weitergeleitete Frage: Der Vorgang im Postfach ist damit erledigt.
  if (clarification.forwardedRequestId) {
    await prisma.supportRequest.update({
      where: { id: clarification.forwardedRequestId },
      data: { status: "CLOSED" },
    });
  }

  const outcome = await applyEffect(effect, clarification.id, projectId);
  revalidateProject(projectId);
  return ok(`Beschluss festgehalten. ${outcome}`);
}

/// Was ein Beschluss in der Arbeit bewirkt. Ohne diesen Schritt waere eine
/// Klaerung nur eine Notiz – das Team stuende weiter still.
async function applyEffect(
  effect: ClarificationEffect,
  clarificationId: string,
  projectId: string,
): Promise<string> {
  const clarification = await prisma.clarification.findUniqueOrThrow({ where: { id: clarificationId } });

  if (effect === "stop") {
    await prisma.$transaction([
      prisma.project.update({ where: { id: projectId }, data: { autopilot: false } }),
      prisma.activityLogEntry.create({
        data: {
          projectId,
          actor: "Mensch",
          action: "team_waiting",
          detail: "Das Team arbeitet auf diesen Beschluss hin nicht weiter.",
        },
      }),
    ]);
    return `Das Team bleibt stehen – über „Nächsten Schritt anstoßen" geht es weiter.`;
  }

  if (effect === "skip" && clarification.ticketId) {
    // Zurueck in den Backlog statt im Sprint zu verhungern: Das Ticket bleibt
    // erhalten, aber der laufende Sprint kommt ohne es zum Abschluss.
    const ticket = await prisma.ticket.update({
      where: { id: clarification.ticketId },
      data: { status: "BACKLOG", sprintId: null },
    });
    await prisma.activityLogEntry.create({
      data: {
        projectId,
        ticketId: ticket.id,
        actor: "Mensch",
        action: "ticket_deferred",
        detail: `„${ticket.title}" zurück in den Backlog gestellt.`,
      },
    });
    const next = await scheduleNextStep(projectId);
    return `„${ticket.title}" liegt wieder im Backlog. ${next}`;
  }

  if (effect === "budget") {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: { sprintBudget: { increment: SPRINT_BUDGET_STEP }, autopilot: true },
    });
    const next = await resume(clarification.resumeTask, clarification.resumePayload, projectId);
    return `Budget steht jetzt bei ${project.sprintBudget} Sprints. ${next}`;
  }

  return resume(clarification.resumeTask, clarification.resumePayload, projectId);
}

/// Nimmt den eingefrorenen Schritt wieder auf. Ist keiner hinterlegt (z.B. bei
/// einem durch Neustart verlorenen Job), bestimmt Scrumy aus dem Board, was
/// ansteht – das Team soll nie am fehlenden Payload scheitern.
async function resume(
  task: string | null,
  payload: unknown,
  projectId: string,
): Promise<string> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.status !== "ACTIVE") {
    return `Das Projekt ist nicht aktiv – über „Arbeit fortsetzen" nimmt das Team sie wieder auf.`;
  }

  if (task && payload && typeof payload === "object") {
    const agentId = (payload as { agentId?: string }).agentId;
    if (agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (agent) {
        // Der eingefrorene Payload stammt aus derselben Queue, in die er
        // zurueckgeht – die Typen sind dieselben, nur ueber die Datenbank
        // gereist und dadurch fuer TypeScript wieder unbekannt.
        await enqueueAgentJob(
          task as keyof GraphileWorker.Tasks,
          payload as GraphileWorker.Tasks[keyof GraphileWorker.Tasks],
        );
        // Blockiert-Anzeige aufheben: Der Kollege hat wieder etwas zu tun.
        await prisma.agent.updateMany({
          where: { id: agent.id, status: "BLOCKED" },
          data: { status: "IDLE" },
        });
        return `${agent.name} nimmt die Arbeit wieder auf.`;
      }
    }
  }

  return scheduleNextStep(projectId);
}

/// Klaerung zuruecknehmen – wenn sich die Frage von selbst erledigt hat.
export async function withdrawClarification(formData: FormData): Promise<ActionResult> {
  const clarificationId = str(formData, "clarificationId");
  if (!clarificationId) return fail("Keine Klärung angegeben.");

  const clarification = await prisma.clarification.findUnique({ where: { id: clarificationId } });
  if (!clarification) return fail("Klärung nicht gefunden.");
  if (clarification.status !== "OPEN") return note("Diese Klärung ist bereits entschieden.");

  await prisma.$transaction([
    prisma.clarification.update({
      where: { id: clarificationId },
      data: { status: "WITHDRAWN", decidedBy: "Mensch", decidedAt: new Date() },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId: clarification.projectId,
        ticketId: clarification.ticketId,
        actor: "Mensch",
        action: "clarification_withdrawn",
        detail: `Klärung zurückgezogen: „${clarification.question.slice(0, 200)}"`,
      },
    }),
  ]);

  revalidateProject(clarification.projectId);
  return ok("Klärung zurückgezogen. Das Team kann an der Stelle weiterarbeiten.");
}

/// Kanal, ueber den eine Frage beim Kunden landet. Ohne Connector bleibt sie
/// im Kundenportal – erfasst ist sie in jedem Fall.
const CHANNEL_FOR_PROVIDER: Record<ConnectorProvider, SupportChannel> = {
  JIRA: "JIRA",
  ZENDESK: "CHAT",
  EMAIL: "EMAIL",
  GIT: "PORTAL",
  GENERIC_WEBHOOK: "PORTAL",
};

/// AP-5: Die Frage ist keine für die Beratung, sondern eine für den Kunden.
/// Sie geht deshalb durch dieselbe Pipeline wie jede Kundenkorrespondenz –
/// als Vorgang im Support-Postfach, mit dem die Antwort später zurückkommt.
export async function forwardClarification(formData: FormData): Promise<ActionResult> {
  const clarificationId = str(formData, "clarificationId");
  const contact = str(formData, "contact");
  if (!clarificationId) return fail("Keine Klärung angegeben.");

  const clarification = await prisma.clarification.findUnique({
    where: { id: clarificationId },
    include: { project: { include: { organization: true } }, ticket: true },
  });
  if (!clarification) return fail("Klärung nicht gefunden.");
  if (clarification.status !== "OPEN") return note("Diese Klärung ist bereits entschieden.");
  if (clarification.forwardedRequestId) return note("Diese Frage liegt bereits beim Kunden.");

  const organizationId = clarification.project.organizationId;

  // Projektbezogener Connector zuerst: Er ist der genauere Kanal (z.B. das
  // Jira-Board dieses Projekts) gegenueber dem kundenweiten Postfach.
  const connector = await prisma.connector.findFirst({
    where: {
      organizationId,
      status: "ACTIVE",
      provider: { in: ["JIRA", "ZENDESK", "EMAIL", "GENERIC_WEBHOOK"] },
      OR: [{ projectId: clarification.projectId }, { projectId: null }],
    },
    orderBy: [{ projectId: "desc" }, { createdAt: "asc" }],
  });

  const options = readOptions(clarification.options);
  const body =
    `${clarification.question}\n\n` +
    (clarification.agenda ? `${clarification.agenda}\n\n` : "") +
    (clarification.context ? `Hintergrund:\n${clarification.context}\n\n` : "") +
    (options.length > 0
      ? `Zur Auswahl:\n${options.map((option) => `- ${option.label}${option.detail ? `: ${option.detail}` : ""}`).join("\n")}\n\n`
      : "") +
    `(Rückfrage des Teams aus dem Projekt „${clarification.project.name}".)`;

  const request = await prisma.supportRequest.create({
    data: {
      organizationId,
      connectorId: connector?.id ?? null,
      channel: connector ? CHANNEL_FOR_PROVIDER[connector.provider] : "PORTAL",
      subject: `Rückfrage des Teams${clarification.ticket ? `: ${clarification.ticket.title}` : ""}`,
      body,
      fromContact: contact,
      status: "NEW",
    },
  });

  await prisma.$transaction([
    prisma.clarification.update({
      where: { id: clarificationId },
      data: { forwardedAt: new Date(), forwardedRequestId: request.id },
    }),
    prisma.activityLogEntry.create({
      data: {
        projectId: clarification.projectId,
        ticketId: clarification.ticketId,
        supportRequestId: request.id,
        actor: "Mensch",
        action: "clarification_forwarded",
        detail:
          `An den Kunden weitergeleitet (${connector?.name ?? "Kundenportal"}): ` +
          `„${clarification.question.slice(0, 200)}"`,
      },
    }),
  ]);

  revalidateProject(clarification.projectId);
  return ok(
    `Die Frage liegt jetzt im Support-Postfach von ${clarification.project.organization.name}` +
      `${connector ? ` (${connector.name})` : ""}. Sobald die Antwort da ist, hältst du sie hier als Beschluss fest.`,
  );
}
