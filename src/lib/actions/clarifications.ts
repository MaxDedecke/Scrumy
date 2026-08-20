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
import { resolveClarification } from "@/lib/clarificationDecision";
import { DELEGATE_OPTION_KEY, OWN_OPTION_KEY, readOptions, type ClarificationEffect } from "@/lib/clarificationOptions";
import { agentForRole } from "@/lib/team";
import type { Clarification, ConnectorProvider, SupportChannel } from "@/generated/prisma/client";
import { enqueueAgentJob } from "../../../worker/queue";

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

  if (optionKey === DELEGATE_OPTION_KEY) return delegateClarification(clarification);

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

  const outcome = await resolveClarification({
    clarificationId: clarification.id,
    decision,
    effect,
    decidedBy: "Mensch",
    byHuman: true,
  });
  revalidateProject(projectId);
  return ok(`Beschluss festgehalten. ${outcome}`);
}

/// „Team soll entscheiden": Liegt vom Product Owner schon eine Empfehlung vor
/// (siehe clarificationTriage), setzt sie das Team sofort um – kein LLM-Aufruf
/// noetig, der Mensch hat ja gerade zugestimmt. Sonst prueft der Product Owner
/// die Klaerung jetzt selbst, mit `forceDecide`: anders als beim normalen
/// Triage-Lauf legt er sie diesmal unter keinen Umstaenden erneut vor.
async function delegateClarification(
  clarification: Clarification & { ticket: { id: string } | null },
): Promise<ActionResult> {
  const options = readOptions(clarification.options);
  const recommended = clarification.recommendedOptionKey
    ? options.find((option) => option.key === clarification.recommendedOptionKey)
    : undefined;

  if (recommended) {
    const outcome = await resolveClarification({
      clarificationId: clarification.id,
      decision: `${recommended.label} – auf deinen Wunsch entschieden`,
      effect: recommended.effect,
      decidedBy: "Team (auf deinen Wunsch)",
      // Der Weg kommt vom Team, der Klick vom Menschen – fuer das Anlauf-Budget
      // zaehlt der Klick.
      byHuman: true,
    });
    revalidateProject(clarification.projectId);
    return ok(`An das Team delegiert. ${outcome}`);
  }

  if (options.length === 0) {
    return fail("Es gibt noch keine Wege, zwischen denen das Team wählen könnte – bitte kurz warten oder selbst entscheiden.");
  }

  const decider =
    (await agentForRole(clarification.projectId, "PRODUCT_OWNER")) ??
    (await agentForRole(clarification.projectId, "SCRUM_MASTER"));
  if (!decider) return fail("Kein Product Owner oder Scrum Master im Team – bitte selbst einen Weg auswählen.");

  await enqueueAgentJob("clarificationTriage", {
    agentId: decider.id,
    projectId: clarification.projectId,
    clarificationId: clarification.id,
    reason: "Auftraggeber hat die Entscheidung delegiert",
    forceDecide: true,
  });

  revalidateProject(clarification.projectId);
  return ok(`${decider.name} entscheidet jetzt – die Klärung schließt sich gleich von selbst.`);
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
