// Sprint-Planung durch den Product Owner.
//
// Er schaut, was vom Auftrag noch offen ist, schneidet daraus die nächsten
// Tickets und gibt dem Sprint ein Ziel. Wenn aus seiner Sicht alles aus
// Konzept und Anforderungen umgesetzt ist, sagt er das ausdrücklich – dann
// hört das Team auf, statt sich Arbeit auszudenken.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { commitAll, writeFiles } from "@/lib/workspace";
import { agentForRole, roleForTicket } from "@/lib/team";
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import type { Priority, TicketType } from "@/generated/prisma/client";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject, MAX_SPRINTS } from "../orchestration";
import type { SprintPlanningPayload } from "../taskTypes";

/// Wie viele Tickets ein Sprint hoechstens bekommt. Kleine Sprints halten die
/// Rueckmeldeschleife zum Menschen kurz – er sieht frueher, wohin es laeuft.
const MAX_TICKETS_PER_SPRINT = 5;

interface PlannedTicket {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  priority?: unknown;
  estimate?: unknown;
  role?: unknown;
  critical?: unknown;
}

function asTicketType(value: unknown): TicketType {
  const known: TicketType[] = ["FEATURE", "BUG", "INTEGRATION", "CHORE"];
  const normalized = String(value ?? "").toUpperCase();
  return known.find((type) => type === normalized) ?? "FEATURE";
}

function asPriority(value: unknown): Priority {
  const known: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
  const normalized = String(value ?? "").toUpperCase();
  return known.find((priority) => priority === normalized) ?? "MEDIUM";
}

const sprintPlanning: Task<"sprintPlanning"> = async (payload: SprintPlanningPayload, helpers) => {
  const { agentId, projectId, reason } = payload;

  const project = await loadWorkingProject(projectId);
  if (!project) {
    helpers.logger.info(`Projekt ${projectId} ist nicht aktiv – Sprint-Planung übersprungen.`);
    return;
  }

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  const previousSprints = await prisma.sprint.findMany({
    where: { projectId },
    orderBy: { number: "asc" },
    include: { tickets: true },
  });
  const nextNumber = (previousSprints.at(-1)?.number ?? 0) + 1;

  if (nextNumber > MAX_SPRINTS) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "team_halted",
      detail: `Obergrenze von ${MAX_SPRINTS} Sprints erreicht – das Team wartet auf eine Entscheidung.`,
    });
    await prisma.project.update({ where: { id: projectId }, data: { autopilot: false } });
    return;
  }

  const history = previousSprints
    .map((sprint) => {
      const done = sprint.tickets.filter((ticket) => ticket.status === "DONE").length;
      return `Sprint ${sprint.number} (${sprint.status}): ${sprint.goal} – ${done}/${sprint.tickets.length} Tickets fertig` +
        (sprint.summary ? `\n  Review: ${sprint.summary.slice(0, 600)}` : "");
    })
    .join("\n");

  const context = await buildProjectContext(projectId);
  const { text } = await runAgent({
    agent,
    projectId,
    kind: "sprint_planning",
    headline: `Plant Sprint ${nextNumber}`,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Product Owner. Du planst Sprint ${nextNumber}. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `${context}

# Bisherige Sprints
${history || "(noch keine)"}

Plane Sprint ${nextNumber}. Wähle die nächsten Arbeitspakete so, dass sie aufeinander aufbauen und der Kunde nach dem Sprint etwas Sichtbares hat. Höchstens ${MAX_TICKETS_PER_SPRINT} Tickets, jedes in einem Arbeitsschritt umsetzbar.

Wenn aus Konzept und Anforderungen nichts Wesentliches mehr offen ist, setze "done" auf true und lass "tickets" leer.

Antworte nur mit diesem JSON-Objekt:
{
  "goal": "Sprint-Ziel in einem Satz",
  "done": false,
  "doneReason": "nur wenn done=true: warum der Auftrag erfüllt ist",
  "tickets": [
    {
      "title": "kurzer Titel",
      "description": "was zu tun ist und woran man sieht, dass es fertig ist",
      "type": "FEATURE | BUG | INTEGRATION | CHORE",
      "priority": "LOW | MEDIUM | HIGH | URGENT",
      "estimate": 3,
      "role": "BACKEND | FRONTEND | QA | DEVOPS",
      "critical": false
    }
  ]
}

"critical" bedeutet: die Änderung braucht vor dem Ausliefern eine menschliche Freigabe (z.B. Datenmigration, Zahlungen, Löschvorgänge, Zugriffsrechte).`,
  });

  const parsed = extractJsonObject(text);
  const goal = String(parsed.goal ?? "").trim() || `Sprint ${nextNumber}`;
  const planned = Array.isArray(parsed.tickets) ? (parsed.tickets as PlannedTicket[]) : [];

  if (parsed.done === true || planned.length === 0) {
    const detail = String(parsed.doneReason ?? "").trim() ||
      "Der Product Owner sieht keine offenen Arbeitspakete mehr aus Konzept und Anforderungen.";
    await prisma.project.update({ where: { id: projectId }, data: { autopilot: false } });
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "backlog_empty",
      detail: `Kein weiterer Sprint geplant: ${detail}`,
    });
    helpers.logger.info(`Projekt ${projectId}: Backlog leer, Team hält an.`);
    return;
  }

  const sprint = await prisma.sprint.create({
    data: { projectId, number: nextNumber, goal, status: "ACTIVE" },
  });

  const createdTickets = [];
  for (const item of planned.slice(0, MAX_TICKETS_PER_SPRINT)) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;

    const role = roleForTicket(typeof item.role === "string" ? item.role : null);
    const assignee = await agentForRole(projectId, role);

    createdTickets.push(
      await prisma.ticket.create({
        data: {
          projectId,
          sprintId: sprint.id,
          title,
          description: typeof item.description === "string" ? item.description : null,
          type: asTicketType(item.type),
          priority: asPriority(item.priority),
          estimate: Number.isFinite(Number(item.estimate)) ? Number(item.estimate) : null,
          isCritical: item.critical === true,
          assigneeId: assignee?.id ?? null,
        },
      }),
    );
  }

  // Sprint-Plan auch im Repo ablegen: Der Auftraggeber soll den Plan dort
  // finden, wo auch das Ergebnis liegt, nicht nur in der Oberflaeche.
  if (project.workspacePath) {
    const planDoc =
      `# Sprint ${sprint.number}\n\n**Ziel:** ${goal}\n\n**Geplant von:** ${agent.name} (Product Owner)\n\n## Tickets\n\n` +
      createdTickets
        .map(
          (ticket) =>
            `### ${ticket.title}\n\n- Typ: ${TICKET_TYPE_LABEL[ticket.type]}\n- Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
            `${ticket.estimate ? `\n- Schätzung: ${ticket.estimate} Punkte` : ""}` +
            `${ticket.isCritical ? "\n- **Kritisch: braucht menschliche Freigabe**" : ""}` +
            `${ticket.description ? `\n\n${ticket.description}` : ""}`,
        )
        .join("\n\n");

    await writeFiles(project.workspacePath, [
      { path: `docs/sprints/sprint-${sprint.number}-plan.md`, content: planDoc },
    ]);
    await commitAll(project.workspacePath, {
      message: `Sprint ${sprint.number} geplant: ${goal}`,
      authorName: agent.name,
    });
  }

  await logActivity({
    projectId,
    actor: agent.name,
    agentId: agent.id,
    action: "sprint_planned",
    detail: `Sprint ${sprint.number} geplant – Ziel: ${goal} (${createdTickets.length} Tickets)`,
  });

  helpers.logger.info(`Sprint ${sprint.number} für Projekt ${projectId} geplant (${reason}).`);
  await continueSprint(projectId, sprint.id);
};

export default sprintPlanning;
