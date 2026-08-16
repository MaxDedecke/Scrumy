// Der Chef kommt ins Büro und fragt nach dem Stand.
//
// Der Scrum Master antwortet – aber nicht aus dem Bauch heraus: Er bekommt
// denselben Projektkontext wie das Team plus das, was tatsächlich passiert
// ist (Sprints, Tickets, Commits, Protokoll, Agentenläufe). Damit ist die
// Antwort belegbar; wo die Belege nichts hergeben, soll er das sagen statt zu
// spekulieren.
//
// Läuft bewusst auch bei pausiertem Projekt: Rechenschaft schuldet das Team
// auch dann, wenn gerade niemand arbeitet.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { gitLog } from "@/lib/workspace";
import { TICKET_STATUS_LABEL } from "@/lib/labels";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import type { TeamInquiryPayload } from "../taskTypes";

const teamInquiry: Task<"teamInquiry"> = async (payload: TeamInquiryPayload, helpers) => {
  const { agentId, projectId, inquiryId } = payload;

  const inquiry = await prisma.teamInquiry.findUnique({ where: { id: inquiryId } });
  if (!inquiry || inquiry.status !== "PENDING") return;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const [sprints, tickets, activity, runs, previousInquiries] = await Promise.all([
    prisma.sprint.findMany({ where: { projectId }, orderBy: { number: "asc" }, include: { tickets: true } }),
    prisma.ticket.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      include: { assignee: true, sprint: true, reviews: true },
    }),
    prisma.activityLogEntry.findMany({
      where: { OR: [{ projectId }, { ticket: { projectId } }] },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    prisma.agentRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: 25,
      include: { agent: true },
    }),
    prisma.teamInquiry.findMany({
      where: { projectId, status: "ANSWERED" },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
  ]);

  const commits = project.workspacePath ? await gitLog(project.workspacePath, 25) : [];

  const sprintReport = sprints
    .map((sprint) => {
      const done = sprint.tickets.filter((ticket) => ticket.status === "DONE").length;
      return `Sprint ${sprint.number} (${sprint.status}): ${sprint.goal} – ${done}/${sprint.tickets.length} fertig` +
        (sprint.summary ? `\n  Review-Auszug: ${sprint.summary.slice(0, 800)}` : "");
    })
    .join("\n");

  const ticketReport = tickets
    .map(
      (ticket) =>
        `- [${TICKET_STATUS_LABEL[ticket.status]}] ${ticket.title}` +
        `${ticket.sprint ? ` (Sprint ${ticket.sprint.number})` : ""}` +
        `${ticket.assignee ? ` – ${ticket.assignee.name}` : ""}` +
        `${ticket.reviews.some((review) => review.decision === "PENDING") ? " – wartet auf deine Freigabe" : ""}` +
        `${ticket.result ? `\n  Ergebnis: ${ticket.result.slice(0, 400)}` : ""}`,
    )
    .join("\n");

  const activityReport = activity
    .map((entry) => `${entry.createdAt.toISOString()} · ${entry.actor}: ${entry.action}${entry.detail ? ` – ${entry.detail}` : ""}`)
    .join("\n");

  const runReport = runs
    .map(
      (run) =>
        `${run.startedAt.toISOString()} · ${run.agent?.name ?? "?"} · ${run.kind} · ${run.status}: ${run.headline}` +
        (run.error ? ` (Fehler: ${run.error.slice(0, 200)})` : ""),
    )
    .join("\n");

  const commitReport = commits.map((commit) => `${commit.shortSha} ${commit.author}: ${commit.subject}`).join("\n");

  const history = previousInquiries
    .reverse()
    .map((entry) => `Frage: ${entry.question}\nAntwort: ${entry.answer?.slice(0, 800) ?? ""}`)
    .join("\n\n");

  const context = await buildProjectContext(projectId, { includeBoard: false });

  try {
    const { text } = await runAgent({
      agent,
      projectId,
      kind: "inquiry",
      headline: `Beantwortet eine Rückfrage: „${inquiry.question.slice(0, 80)}"`,
      maxTokens: 4000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Scrum Master dieses Projekts. Der Auftraggeber steht vor dir und fragt nach. Antworte wie im Gespräch: direkt auf die Frage, mit konkreten Belegen (Ticket, Commit-Hash, Sprint) statt allgemeiner Floskeln. Wenn die Daten die Frage nicht hergeben, sag genau das. Antworte als Fließtext mit höchstens kurzen Aufzählungen, ohne Überschriften-Wust.`,
      prompt: `${context}

# Sprints
${sprintReport || "(noch keine)"}

# Tickets
${ticketReport || "(noch keine)"}

# Commits im Repository
${commitReport || "(noch keine)"}

# Protokoll (neueste zuerst)
${activityReport || "(leer)"}

# Letzte Agentenläufe
${runReport || "(keine)"}

${history ? `# Frühere Rückfragen\n${history}\n` : ""}
# Frage des Auftraggebers
${inquiry.question}`,
    });

    await prisma.teamInquiry.update({
      where: { id: inquiryId },
      data: { answer: text, status: "ANSWERED", answeredById: agent.id, answeredAt: new Date() },
    });
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "inquiry_answered",
      detail: `Rückfrage beantwortet: „${inquiry.question.slice(0, 160)}"`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.teamInquiry.update({
      where: { id: inquiryId },
      data: { answer: `Die Antwort konnte nicht erzeugt werden: ${message}`, status: "FAILED", answeredAt: new Date() },
    });
    throw error;
  }

  helpers.logger.info(`Rückfrage ${inquiryId} beantwortet.`);
};

export default teamInquiry;
