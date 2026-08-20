// Sprint-Review durch den Scrum Master.
//
// Am Sprintende steht nicht "Job erledigt", sondern eine Rechenschaft: Was ist
// geliefert worden, was blieb offen, was empfiehlt das Team als Nächstes. Der
// Text landet im Repo und in der Sprint-Historie – der Auftraggeber kann ihn
// Monate später noch nachlesen.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { commitAll, gitLog, writeFiles } from "@/lib/workspace";
import { TICKET_STATUS_LABEL } from "@/lib/labels";
import { runSprintIntegrationCheck } from "@/lib/liveStack";
import { extractJsonObject } from "@/lib/llm";
import { agentForRole } from "@/lib/team";
import type { Priority, TicketType } from "@/generated/prisma/client";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { handOverTo, loadWorkingProject } from "../orchestration";
import type { SprintReviewPayload } from "../taskTypes";

/// Dieselbe defensive Normalisierung wie in sprintPlanning.ts, hier nur fuer
/// die vom Design-Agenten vorgeschlagenen Folge-Tickets – kein Export, um
/// beide Stellen nicht ueber eine gemeinsame Utility-Datei zu koppeln, die es
/// sonst nirgends braucht.
function asPriority(value: unknown): Priority {
  const known: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
  const normalized = String(value ?? "").toUpperCase();
  return known.find((priority) => priority === normalized) ?? "MEDIUM";
}

function asTicketType(value: unknown): TicketType {
  const known: TicketType[] = ["FEATURE", "BUG", "INTEGRATION", "CHORE"];
  const normalized = String(value ?? "").toUpperCase();
  return known.find((type) => type === normalized) ?? "FEATURE";
}

const sprintReview: Task<"sprintReview"> = async (payload: SprintReviewPayload, helpers) => {
  const { agentId, projectId, sprintId, reason } = payload;

  const project = await loadWorkingProject(projectId);
  if (!project) {
    helpers.logger.info(`Projekt ${projectId} ist nicht aktiv – Sprint-Review übersprungen.`);
    return;
  }

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const sprint = await prisma.sprint.findUniqueOrThrow({
    where: { id: sprintId },
    include: { tickets: { include: { assignee: true, reviews: true } } },
  });
  if (sprint.status === "DONE") return;

  await prisma.sprint.update({ where: { id: sprintId }, data: { status: "REVIEW" } });

  const ticketReport = sprint.tickets
    .map(
      (ticket) =>
        `- [${TICKET_STATUS_LABEL[ticket.status]}] ${ticket.title}` +
        `${ticket.assignee ? ` (${ticket.assignee.name})` : ""}` +
        `${ticket.reviews.some((review) => review.decision === "PENDING") ? " – wartet auf menschliche Freigabe" : ""}` +
        `${ticket.result ? `\n  Ergebnis: ${ticket.result.slice(0, 600)}` : ""}`,
    )
    .join("\n");

  const commits = project.workspacePath
    ? (await gitLog(project.workspacePath, 40)).filter((commit) => commit.date >= sprint.startedAt)
    : [];
  const commitReport = commits.length
    ? commits.map((commit) => `- ${commit.shortSha} ${commit.author}: ${commit.subject}`).join("\n")
    : "(keine Commits in diesem Sprint)";

  // Echte Integrationspruefung statt Modellurteil, wie die Ticket-Checks in
  // ticketWork.ts (siehe src/lib/testRun.ts) – nur eben einmal pro Sprint und
  // gegen den GANZEN Stack (Frontend, Backend, Datenbank), nicht pro Ticket
  // und nur einzelne package.json-Skripte (siehe src/lib/liveStack.ts fuer
  // die Begruendung der Sprint-statt-Ticket-Kadenz).
  const integration = await runSprintIntegrationCheck(projectId);
  const integrationReport = integration.skipped
    ? `Übersprungen: ${integration.reason}`
    : integration.passed
      ? `Bestanden. ${integration.summary}`
      : `NICHT bestanden. ${integration.summary}`;

  const context = await buildProjectContext(projectId, { includeRepo: false });
  const { text } = await runAgent({
    agent,
    projectId,
    sprintId,
    kind: "sprint_review",
    headline: `Schließt Sprint ${sprint.number} ab`,
    maxTokens: 4000,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Scrum Master. Du schreibst das Sprint-Review für den Auftraggeber – ehrlich, auch wenn etwas nicht geklappt hat.`,
    prompt: `${context}

# Sprint ${sprint.number}
Ziel: ${sprint.goal}

## Tickets
${ticketReport || "(keine)"}

## Commits in diesem Sprint
${commitReport}

## Integrationsprüfung (voller Stack, automatisch von Scrumy ausgeführt)
${integrationReport}

Schreibe das Sprint-Review als Markdown (ohne Code-Fence). Gliederung:

# Sprint ${sprint.number} – Review
## Was geliefert wurde
## Was offen blieb (und warum)
## Wo der Auftraggeber gefragt ist
## Empfehlung für den nächsten Sprint

Ist die Integrationsprüfung NICHT bestanden, gehört das unter "Was offen blieb" – kein Blocker für den Sprintabschluss, aber ehrlich benennen.
Keine Selbstbeweihräucherung, keine erfundenen Ergebnisse: Nur was aus Tickets, Commits und der Integrationsprüfung hervorgeht.`,
  });

  if (project.workspacePath) {
    const docContent = `${text}\n\n## Anhang: Integrationsprüfung (voller Stack)\n${integrationReport}\n`;
    await writeFiles(project.workspacePath, [
      { path: `docs/sprints/sprint-${sprint.number}-review.md`, content: docContent },
    ]);
    await commitAll(project.workspacePath, {
      message: `Sprint ${sprint.number} abgeschlossen\n\nReview von ${agent.name} (Scrum Master).`,
      authorName: agent.name,
    });
  }

  if (!integration.skipped) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "integration_check",
      detail: `Sprint ${sprint.number}: ${integrationReport}`,
    });
  }

  // --- Design-Review -------------------------------------------------------
  // Der Design-Agent (falls im Team) blickt am Sprintende zusätzlich über
  // alles, was das Frontend diesen Sprint bewegt hat – nicht mehr Ticket für
  // Ticket wie in ticketWork.ts, sondern im Zusammenhang: Passt das Bild als
  // Ganzes zum Design-Konzept? Konkrete Befunde werden sofort zu
  // BACKLOG-Tickets, die die nächste Sprint-Planung automatisch wieder zieht
  // (siehe "Zurückgestellte Tickets" in sprintPlanning.ts) – Feedback bleibt
  // so nicht im Text stehen, sondern landet direkt im nächsten Sprint.
  const frontendTickets = sprint.tickets.filter((ticket) => ticket.assignee?.role === "FRONTEND");
  const designer = frontendTickets.length > 0 ? await agentForRole(projectId, "DESIGN") : null;
  if (designer && designer.role === "DESIGN") {
    const frontendReport = frontendTickets
      .map(
        (ticket) =>
          `- [${TICKET_STATUS_LABEL[ticket.status]}] ${ticket.title}` +
          `${ticket.result ? `\n  Ergebnis: ${ticket.result.slice(0, 500)}` : ""}`,
      )
      .join("\n");

    const { text: designText } = await runAgent({
      agent: designer,
      projectId,
      sprintId,
      kind: "design_sprint_review",
      headline: `Design-Rückblick auf Sprint ${sprint.number}`,
      maxTokens: 4000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${designer.name}, verantwortlich für das Design-Konzept des Projekts. Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${context}

# Frontend-Tickets aus Sprint ${sprint.number}
${frontendReport || "(keine)"}

Jedes einzelne Ticket wurde bereits gegen das Design-Konzept geprüft (siehe docs/design-konzept.md) – wiederhole das nicht. Blick jetzt auf das Zusammenspiel: Wirkt die Anwendung als Ganzes stimmig, oder ergeben die Einzelteile ein uneinheitliches Bild (z.B. wiederkehrende Muster, die mehrfach leicht unterschiedlich gelöst wurden)? Was sollte der nächste Sprint aus Design-Sicht als Nächstes angehen?

Antworte nur mit diesem JSON-Objekt:
{
  "feedback": "Rückblick als Markdown (ohne Code-Fence), 3-6 Sätze: was passt gut, was wirkt uneinheitlich, worauf der nächste Sprint achten sollte",
  "tickets": [
    {
      "title": "ein einzelnes, kleines Ergebnis",
      "description": "was genau zu tun ist, konkret auf Dateien/Komponenten bezogen",
      "priority": "LOW | MEDIUM | HIGH | URGENT",
      "estimate": 1,
      "type": "BUG | CHORE | FEATURE"
    }
  ]
}

"tickets" nur für konkrete, eigenständig umsetzbare Nacharbeiten (höchstens 4) – keine Wiederholung dessen, was schon in "feedback" steht, und keine Tickets für Geschmacksfragen, die das Design-Konzept offen lässt. Bleibt aus Design-Sicht nichts Konkretes zu tun, "tickets" leer lassen.`,
    });

    const designParsed = extractJsonObject(designText);
    const feedback = String(designParsed.feedback ?? "").trim() || "(kein Feedback)";
    const followUps = Array.isArray(designParsed.tickets) ? designParsed.tickets.slice(0, 4) : [];

    if (project.workspacePath) {
      await writeFiles(project.workspacePath, [
        { path: `docs/sprints/sprint-${sprint.number}-design-review.md`, content: `# Design-Rückblick auf Sprint ${sprint.number}\n\n${feedback}\n` },
      ]);
      await commitAll(project.workspacePath, {
        message: `Design-Rückblick auf Sprint ${sprint.number}\n\nVon ${designer.name} (Design).`,
        authorName: designer.name,
      });
    }

    const frontendAgent = await agentForRole(projectId, "FRONTEND");
    const createdTitles: string[] = [];
    for (const item of followUps) {
      const title = String((item as { title?: unknown }).title ?? "").trim();
      if (!title) continue;
      const description = String((item as { description?: unknown }).description ?? "").trim();
      const priority = asPriority((item as { priority?: unknown }).priority);
      const type = asTicketType((item as { type?: unknown }).type);
      const estimateRaw = Number((item as { estimate?: unknown }).estimate);
      const estimate = Number.isFinite(estimateRaw) ? Math.min(3, Math.max(1, estimateRaw)) : 1;

      await prisma.ticket.create({
        data: {
          projectId,
          title,
          description: description || null,
          type,
          priority,
          estimate,
          assigneeId: frontendAgent?.id ?? null,
        },
      });
      createdTitles.push(title);
    }

    await logActivity({
      projectId,
      actor: designer.name,
      agentId: designer.id,
      action: "design_feedback",
      detail:
        `Sprint ${sprint.number}: ${feedback.slice(0, 300)}` +
        (createdTitles.length > 0
          ? ` – ${createdTitles.length} neue ${createdTitles.length === 1 ? "Ticket" : "Tickets"} für den nächsten Sprint: ${createdTitles.map((t) => `„${t}"`).join(", ")}`
          : ""),
    });
  }

  const doneCount = sprint.tickets.filter((ticket) => ticket.status === "DONE").length;
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { status: "DONE", summary: text, endedAt: new Date() },
  });
  await logActivity({
    projectId,
    actor: agent.name,
    agentId: agent.id,
    action: "sprint_reviewed",
    detail: `Sprint ${sprint.number} abgeschlossen – ${doneCount}/${sprint.tickets.length} Tickets fertig`,
  });

  helpers.logger.info(`Sprint ${sprint.number} abgeschlossen (${reason}).`);

  // Autopilot aus heißt: Das Team hält nach dem Sprint an und wartet auf den
  // Menschen – wie ein Team, das nach dem Review erst das nächste Go abwartet.
  const current = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!current.autopilot) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "team_waiting",
      detail: "Autopilot ist aus – das Team wartet auf die Freigabe des nächsten Sprints.",
    });
    return;
  }

  await handOverTo("PRODUCT_OWNER", "sprintPlanning", projectId, {
    reason: `Sprint ${sprint.number} abgeschlossen`,
  });
};

export default sprintReview;
