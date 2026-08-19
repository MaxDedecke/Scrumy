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
import { continueSprint, loadWorkingProject } from "../orchestration";
import { openClarification } from "../clarification";
import type { SprintPlanningPayload } from "../taskTypes";

/// Wie viele Tickets ein Sprint hoechstens bekommt. Kleine Sprints halten die
/// Rueckmeldeschleife zum Menschen kurz – er sieht frueher, wohin es laeuft.
const MAX_TICKETS_PER_SPRINT = 5;

/// Um wie viele Sprints der Auftraggeber das Budget aufstockt, wenn er nach
/// dem Aufbrauchen weiterarbeiten laesst.
export const SPRINT_BUDGET_STEP = 6;

interface PlannedTicket {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  priority?: unknown;
  estimate?: unknown;
  role?: unknown;
  critical?: unknown;
  acceptanceCriteria?: unknown;
  likelyFiles?: unknown;
  dependsOn?: unknown;
}

const MAX_FILES_PER_TICKET = 4;
const MAX_CRITERIA_PER_TICKET = 4;

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, limit)
    : [];
}

function atomicityIssues(ticket: PlannedTicket): string[] {
  const issues: string[] = [];
  const estimate = Number(ticket.estimate);
  const files = stringList(ticket.likelyFiles, 100);
  const criteria = stringList(ticket.acceptanceCriteria, 100);
  if (!Number.isFinite(estimate) || estimate < 1 || estimate > 3) issues.push("Schätzung muss 1–3 sein");
  if (files.length === 0 || files.length > MAX_FILES_PER_TICKET) issues.push("1–4 voraussichtliche Dateien nötig");
  if (criteria.length === 0 || criteria.length > MAX_CRITERIA_PER_TICKET) issues.push("1–4 Akzeptanzkriterien nötig");
  return issues;
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
  // scheduleNextStep (src/lib/nextStep.ts) und die Autopilot-Kette
  // (worker/tasks/sprintReview.ts) reihen beide unabhängig voneinander einen
  // sprintPlanning-Job ein, sobald sie den letzten Sprint als DONE sehen –
  // ohne sich gegenseitig zu kennen. Feuern zwei solcher Anstöße kurz
  // hintereinander, ist der letzte Sprint zum Zeitpunkt des zweiten Jobs
  // bereits neu geplant (ACTIVE) statt DONE: Dann ist dieser Anlauf ein
  // Doppel-Anstoß und plant nichts. Ohne diese Prüfung entstanden in OurJira
  // zwei Sprints mit fast identischem Ziel und Ticket-Set 59 Sekunden
  // auseinander, seither parallel gegeneinander bearbeitet (bis hin zu zwei
  // Agenten gleichzeitig am selben Ticket).
  const latestSprint = previousSprints.at(-1);
  if (latestSprint && latestSprint.status !== "DONE") {
    helpers.logger.info(
      `Sprint ${latestSprint.number} ist bereits ${latestSprint.status} – Sprint-Planung übersprungen (Doppel-Anstoß).`,
    );
    // Nach einem erfolgreichen lokalen Commit, dessen Remote-Push kurzzeitig
    // scheiterte, kommt derselbe Planungsjob ebenfalls hier an: Der zentrale
    // Repo-Abgleich hat den Commit beim Retry bereits gepusht, aber der erste
    // Anlauf konnte den nächsten Ticket-Job noch nicht einreihen. Das
    // jobKey-Deduping der Ticket-Queue macht den Aufruf auch für einen echten
    // Doppel-Anstoß sicher.
    await continueSprint(projectId, latestSprint.id);
    return;
  }

  const nextNumber = (latestSprint?.number ?? 0) + 1;

  if (nextNumber > project.sprintBudget) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "team_halted",
      detail: `Sprint-Budget von ${project.sprintBudget} Sprints aufgebraucht – das Team wartet auf eine Entscheidung.`,
    });
    await prisma.project.update({ where: { id: projectId }, data: { autopilot: false } });
    await openClarification({
      projectId,
      scope: "PROJECT",
      trigger: "sprint_budget",
      raisedById: agent.id,
      question: `Das Sprint-Budget (${project.sprintBudget} Sprints) ist aufgebraucht. Soll das Team weiterarbeiten?`,
      context:
        `${agent.name} (Product Owner) wollte Sprint ${nextNumber} planen. Das Budget begrenzt, wie lange das Team ` +
        `ohne neue Entscheidung des Auftraggebers weiterbaut – und damit auch die Modellkosten.`,
      options: [
        {
          key: "budget",
          label: `Weiterarbeiten (${SPRINT_BUDGET_STEP} Sprints mehr)`,
          detail: `Das Budget steigt auf ${project.sprintBudget + SPRINT_BUDGET_STEP} Sprints, ${agent.name} plant Sprint ${nextNumber}.`,
          effect: "budget",
        },
        {
          key: "stop",
          label: "Hier ist Schluss",
          detail: "Das Team hält an; du kannst später jederzeit den nächsten Schritt anstoßen.",
          effect: "stop",
        },
      ],
      resume: { task: "sprintPlanning", payload },
      prepare: false,
    });
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
  const planningPrompt = `${context}

# Bisherige Sprints
${history || "(noch keine)"}

Plane Sprint ${nextNumber}. Wähle die nächsten Arbeitspakete so, dass sie aufeinander aufbauen und der Kunde nach dem Sprint etwas Sichtbares hat. Höchstens ${MAX_TICKETS_PER_SPRINT} Tickets.

Ein Ticket ist ein EINZELNER, in einem Modellaufruf umsetzbarer und prüfbarer Schritt – kein Epic. Harte Grenzen je Ticket:
- genau ein technisches Ergebnis und 1–4 konkrete Akzeptanzkriterien,
- Schätzung 1–3,
- voraussichtlich höchstens ${MAX_FILES_PER_TICKET} neu anzulegende oder zu ändernde Dateien,
- Frontend, Backend, Datenmodell, Migration, Integration und Tests bei größerem Umfang in abhängige Tickets trennen,
- Titel mit mehreren großen Komponenten (z.B. „Canvas und WebSocket-Anbindung") weiter zerlegen.

Eine große Anwendung ist kein Grund für große Tickets: Plane nur den nächsten kleinen Schnitt; weitere Schnitte kommen in späteren Sprints.

Wenn aus Konzept und Anforderungen nichts Wesentliches mehr offen ist, setze "done" auf true und lass "tickets" leer.

Antworte nur mit diesem JSON-Objekt:
{
  "goal": "Sprint-Ziel in einem Satz",
  "done": false,
  "doneReason": "nur wenn done=true: warum der Auftrag erfüllt ist",
  "tickets": [
    {
      "title": "ein einzelnes, kleines Ergebnis",
      "description": "was genau zu tun ist",
      "acceptanceCriteria": ["konkret prüfbares Kriterium"],
      "likelyFiles": ["relativer/pfad.ts"],
      "dependsOn": ["Titel eines vorherigen Tickets in diesem Sprint"],
      "type": "FEATURE | BUG | INTEGRATION | CHORE",
      "priority": "LOW | MEDIUM | HIGH | URGENT",
      "estimate": 1,
      "role": "BACKEND | FRONTEND | QA | DEVOPS",
      "critical": false
    }
  ]
}

"critical" bedeutet: die Änderung braucht vor dem Ausliefern eine menschliche Freigabe (z.B. Datenmigration, Zahlungen, Löschvorgänge, Zugriffsrechte).`;

  const { text } = await runAgent({
    agent,
    projectId,
    kind: "sprint_planning",
    headline: `Plant Sprint ${nextNumber}`,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Product Owner. Du planst Sprint ${nextNumber}. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: planningPrompt,
  });

  let parsed = extractJsonObject(text);
  let planned = Array.isArray(parsed.tickets) ? (parsed.tickets as PlannedTicket[]) : [];

  const issues = planned.flatMap((ticket, index) =>
    atomicityIssues(ticket).map((issue) => `Ticket ${index + 1} „${String(ticket.title ?? "")}": ${issue}`),
  );
  if (parsed.done !== true && issues.length > 0) {
    const refined = await runAgent({
      agent,
      projectId,
      kind: "sprint_refinement",
      headline: `Zerlegt zu große Tickets für Sprint ${nextNumber}`,
      maxTokens: 5000,
      system: `${TEAM_GRUNDREGELN}\n\nDu bist ${agent.name}, Product Owner. Du zerlegst zu große Tickets. Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `${planningPrompt}\n\n# Erster Entwurf\n${JSON.stringify(parsed)}\n\n# Verstöße gegen die harten Ticketgrenzen\n${issues.join("\n")}\n\nSchreibe den gesamten Sprintentwurf neu. Zerlege die genannten Tickets, statt nur Schätzung oder Dateiliste künstlich zu kürzen. Maximal ${MAX_TICKETS_PER_SPRINT} Tickets; was nicht hineinpasst, bleibt für den nächsten Sprint.`,
    });
    parsed = extractJsonObject(refined.text);
    planned = Array.isArray(parsed.tickets) ? (parsed.tickets as PlannedTicket[]) : [];
  }

  const goal = String(parsed.goal ?? "").trim() || `Sprint ${nextNumber}`;

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

    // „Wir sind fertig" ist eine Behauptung des Teams, keine Tatsache. Sie
    // gehoert dem Auftraggeber vorgelegt – widerspricht er, steht sein
    // Beschluss im Beschlussregister und damit in jedem weiteren Prompt, sodass
    // die naechste Planung nicht wieder bei „nichts mehr offen" landet.
    await openClarification({
      projectId,
      scope: "PROJECT",
      trigger: "backlog_empty",
      raisedById: agent.id,
      question: `${agent.name} sieht aus Konzept und Anforderungen nichts Wesentliches mehr offen. Ist der Auftrag damit erfüllt?`,
      context: detail,
      options: [
        {
          key: "stop",
          label: "Ja, der Auftrag ist erfüllt",
          detail: "Das Team hält an. Neue Arbeit kommt über Anforderungen oder Kundenanfragen.",
          effect: "stop",
        },
        {
          key: "resume",
          label: "Nein, es fehlt noch etwas",
          detail:
            "Schreib unten dazu, was fehlt – das Team plant dann einen weiteren Sprint und hat deinen Beschluss im Auftrag.",
          effect: "resume",
        },
      ],
      resume: { task: "sprintPlanning", payload },
      prepare: false,
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
    const criteria = stringList(item.acceptanceCriteria, MAX_CRITERIA_PER_TICKET);
    const likelyFiles = stringList(item.likelyFiles, MAX_FILES_PER_TICKET);
    const dependencies = stringList(item.dependsOn, MAX_TICKETS_PER_SPRINT);
    const baseDescription = typeof item.description === "string" ? item.description.trim() : "";
    const structuredDescription = [
      baseDescription,
      criteria.length > 0 ? `## Akzeptanzkriterien\n${criteria.map((entry) => `- ${entry}`).join("\n")}` : "",
      likelyFiles.length > 0 ? `## Voraussichtliche Dateien\n${likelyFiles.map((entry) => `- ${entry}`).join("\n")}` : "",
      dependencies.length > 0 ? `## Abhängigkeiten\n${dependencies.map((entry) => `- ${entry}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");

    createdTickets.push(
      await prisma.ticket.create({
        data: {
          projectId,
          sprintId: sprint.id,
          title,
          description: structuredDescription || null,
          type: asTicketType(item.type),
          priority: asPriority(item.priority),
          estimate: Number.isFinite(Number(item.estimate)) ? Math.min(3, Math.max(1, Number(item.estimate))) : 1,
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
