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
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { handOverTo, loadWorkingProject } from "../orchestration";
import type { SprintReviewPayload } from "../taskTypes";

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

Schreibe das Sprint-Review als Markdown (ohne Code-Fence). Gliederung:

# Sprint ${sprint.number} – Review
## Was geliefert wurde
## Was offen blieb (und warum)
## Wo der Auftraggeber gefragt ist
## Empfehlung für den nächsten Sprint

Keine Selbstbeweihräucherung, keine erfundenen Ergebnisse: Nur was aus Tickets und Commits hervorgeht.`,
  });

  if (project.workspacePath) {
    await writeFiles(project.workspacePath, [
      { path: `docs/sprints/sprint-${sprint.number}-review.md`, content: text },
    ]);
    await commitAll(project.workspacePath, {
      message: `Sprint ${sprint.number} abgeschlossen\n\nReview von ${agent.name} (Scrum Master).`,
      authorName: agent.name,
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
