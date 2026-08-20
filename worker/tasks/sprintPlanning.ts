// Sprint-Planung durch den Product Owner.
//
// Er schaut, was vom Auftrag noch offen ist, schneidet daraus die nächsten
// Tickets und gibt dem Sprint ein Ziel. Wenn aus seiner Sicht alles aus
// Konzept und Anforderungen umgesetzt ist, sagt er das ausdrücklich – dann
// hört das Team auf, statt sich Arbeit auszudenken.
//
// Zwei Quellen VOR neuen Tickets aus dem Konzept: zurückgestellte Tickets
// (siehe `pulled` unten) und offene Kundenanfragen (siehe `openRequests`).
// Beide sind deterministisch, nicht dem Modell überlassen – es kennt weder
// den Backlog noch das Support-Postfach zuverlässig und würde sonst leicht
// Doppelgänger erfinden.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { commitAll, writeFiles } from "@/lib/workspace";
import { agentForRole, roleForTicket } from "@/lib/team";
import { PRIORITY_LABEL, SUPPORT_CHANNEL_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import type { Priority, Ticket, TicketType } from "@/generated/prisma/client";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject } from "../orchestration";
import { openClarification } from "../clarification";
import type { SprintPlanningPayload } from "../taskTypes";

/// Wie viele Tickets ein Sprint hoechstens bekommt. Kleine Sprints halten die
/// Rueckmeldeschleife zum Menschen kurz – er sieht frueher, wohin es laeuft.
/// Zurueckgestellte Tickets zaehlen mit: Sie belegen Plaetze, bevor ueberhaupt
/// ein neues Ticket aus dem Konzept entsteht.
const MAX_TICKETS_PER_SPRINT = 5;

/// Wie viele offene Kundenanfragen dem Product Owner zur Pruefung vorgelegt
/// werden. Mehr wuerde den Prompt fluten, ohne dass in einem Sprint ohnehin
/// Platz fuer mehr Tickets waere.
const MAX_SUPPORT_REQUESTS_IN_PROMPT = 8;

/// Reihenfolge, in der zurueckgestellte Tickets wieder gezogen werden –
/// dieselbe Rangfolge wie beim Ziehen vom Board (siehe `nextOpenTicket`),
/// nur zusaetzlich nach Prioritaet sortiert, da hier (anders als innerhalb
/// eines laufenden Sprints) mehr Tickets warten koennen, als Platz ist.
const PRIORITY_RANK: Record<Priority, number> = { URGENT: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

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
  /// 1-basierter Index in die im Prompt gelistete Kundenanfragen-Liste, wenn
  /// dieses Ticket direkt aus einer der Anfragen stammt.
  anfrageNr?: unknown;
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

function formatTicketDoc(ticket: Ticket, note?: string): string {
  return (
    `### ${ticket.title}${note ? ` _(${note})_` : ""}\n\n- Typ: ${TICKET_TYPE_LABEL[ticket.type]}\n- Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
    `${ticket.estimate ? `\n- Schätzung: ${ticket.estimate} Punkte` : ""}` +
    `${ticket.isCritical ? "\n- **Kritisch: braucht menschliche Freigabe**" : ""}` +
    `${ticket.description ? `\n\n${ticket.description}` : ""}`
  );
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

  // --- Zurückgestellte Tickets zuerst ziehen ---------------------------------
  // Ein per Klärungs-Beschluss "skip" zurückgestelltes Ticket (siehe
  // src/lib/clarificationDecision.ts) landet auf BACKLOG, ohne Sprint. Ohne
  // diese Wiedervorlage sah es danach niemand mehr an: Die nächste Planung
  // erzeugte aus Konzept und Anforderungen neue Tickets, das zurückgestellte
  // blieb für immer liegen – "Backlog" war nur ein Wort, kein Zustand, aus dem
  // je wieder gearbeitet wurde.
  const backlogTickets = (
    await prisma.ticket.findMany({ where: { projectId, sprintId: null, status: "BACKLOG" } })
  ).sort(
    (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const pulled = backlogTickets.slice(0, MAX_TICKETS_PER_SPRINT);
  const remainingSlots = Math.max(0, MAX_TICKETS_PER_SPRINT - pulled.length);

  // --- Offene Kundenanfragen, die noch keinem Ticket zugeordnet sind --------
  // Das Support-Postfach beschreibt sich selbst als "vom Product-Owner-Agenten
  // in Tickets überführt" – bis hierher passierte das nirgends im Code, eine
  // neue Anfrage blieb für immer "Neu". `tickets: { none: {} }` schließt auch
  // Anfragen aus, die ein anderes Projekt desselben Kunden schon übernommen
  // hat. Bei vollem Sprint lohnt sich der Blick nicht.
  const openRequests =
    remainingSlots > 0
      ? await prisma.supportRequest.findMany({
          where: { organizationId: project.organizationId, status: { in: ["NEW", "TRIAGED"] }, tickets: { none: {} } },
          orderBy: { createdAt: "asc" },
          take: MAX_SUPPORT_REQUESTS_IN_PROMPT,
        })
      : [];

  const history = previousSprints
    .map((sprint) => {
      const done = sprint.tickets.filter((ticket) => ticket.status === "DONE").length;
      return `Sprint ${sprint.number} (${sprint.status}): ${sprint.goal} – ${done}/${sprint.tickets.length} Tickets fertig` +
        (sprint.summary ? `\n  Review: ${sprint.summary.slice(0, 600)}` : "");
    })
    .join("\n");

  const backlogSection =
    pulled.length > 0
      ? `\n# Zurückgestellte Tickets (werden automatisch wieder in diesen Sprint aufgenommen)\n${pulled
          .map(
            (ticket) =>
              `- „${ticket.title}" (${TICKET_TYPE_LABEL[ticket.type]}, ${PRIORITY_LABEL[ticket.priority]})` +
              `${ticket.description ? `: ${ticket.description.slice(0, 300)}` : ""}`,
          )
          .join("\n")}\n`
      : "";

  const requestSection =
    openRequests.length > 0
      ? `\n# Offene Kundenanfragen (noch keinem Ticket zugeordnet)\n${openRequests
          .map(
            (request, index) =>
              `${index + 1}. [${SUPPORT_CHANNEL_LABEL[request.channel]}${request.fromContact ? `, ${request.fromContact}` : ""}] ` +
              `${request.subject ?? "(kein Betreff)"}: ${request.body.slice(0, 400)}`,
          )
          .join("\n")}\n`
      : "";

  const context = await buildProjectContext(projectId);
  const planningPrompt = `${context}
${backlogSection}${requestSection}
# Bisherige Sprints
${history || "(noch keine)"}

Plane Sprint ${nextNumber}. Wähle die nächsten Arbeitspakete so, dass sie aufeinander aufbauen und der Kunde nach dem Sprint etwas Sichtbares hat.
${
  pulled.length > 0
    ? `${pulled.length} zurückgestellte Tickets sind oben gelistet und werden automatisch wieder in diesen Sprint aufgenommen – plane sie nicht erneut, wiederhole ihren Inhalt nicht.`
    : ""
}
${
  remainingSlots > 0
    ? `Plane höchstens ${remainingSlots} NEUE Tickets zusätzlich dazu.`
    : `Für neue Tickets ist in diesem Sprint kein Platz mehr (die zurückgestellten Tickets oben füllen ihn) – lass "tickets" leer.`
}
${
  openRequests.length > 0
    ? `Prüfe außerdem die oben gelisteten Kundenanfragen: Gehört eine erkennbar zu DIESEM Projekt und ist noch nicht als Ticket abgebildet, erstelle dafür ein Ticket und setze "anfrageNr" auf ihre Nummer aus der Liste. Gehört eine Anfrage erkennbar zu einem anderen Produkt desselben Kunden, lass sie unerwähnt – ein anderes Projekt kümmert sich darum.`
    : ""
}

Ein Ticket ist ein EINZELNER, in einem Modellaufruf umsetzbarer und prüfbarer Schritt – kein Epic. Harte Grenzen je Ticket:
- genau ein technisches Ergebnis und 1–4 konkrete Akzeptanzkriterien,
- Schätzung 1–3,
- voraussichtlich höchstens ${MAX_FILES_PER_TICKET} neu anzulegende oder zu ändernde Dateien,
- Frontend, Backend, Datenmodell, Migration, Integration und Tests bei größerem Umfang in abhängige Tickets trennen,
- Titel mit mehreren großen Komponenten (z.B. „Canvas und WebSocket-Anbindung") weiter zerlegen.

Eine große Anwendung ist kein Grund für große Tickets: Plane nur den nächsten kleinen Schnitt; weitere Schnitte kommen in späteren Sprints.

Wenn aus Konzept und Anforderungen nichts Wesentliches mehr offen ist, setze "done" auf true und lass "tickets" leer.${
    pulled.length > 0
      ? ` Das gilt unabhängig von den zurückgestellten Tickets oben – die zählen so oder so als offene Arbeit.`
      : ""
  }

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
      "critical": false,
      "anfrageNr": 2
    }
  ]
}

"critical" bedeutet: die Änderung braucht vor dem Ausliefern eine menschliche Freigabe (z.B. Datenmigration, Zahlungen, Löschvorgänge, Zugriffsrechte).
"anfrageNr" nur setzen, wenn dieses Ticket direkt eine der oben gelisteten Kundenanfragen abdeckt – sonst weglassen.`;

  const { text } = await runAgent({
    agent,
    projectId,
    kind: "sprint_planning",
    headline: `Plant Sprint ${nextNumber}`,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Product Owner. Du planst Sprint ${nextNumber}. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: planningPrompt,
  });

  const parsed = extractJsonObject(text);
  let planned = Array.isArray(parsed.tickets) ? (parsed.tickets as PlannedTicket[]).slice(0, remainingSlots) : [];

  // Je Ticket einzeln gemerkt (nicht nur als flache Liste), damit unten die
  // bereits passenden Tickets von den zu großen getrennt werden können.
  const ticketIssues = planned.map((ticket) => atomicityIssues(ticket));
  const issues = planned.flatMap((ticket, index) =>
    ticketIssues[index].map((issue) => `Ticket ${index + 1} „${String(ticket.title ?? "")}": ${issue}`),
  );
  if (parsed.done !== true && issues.length > 0) {
    const goodTickets = planned.filter((_, index) => ticketIssues[index].length === 0);
    const badTickets = planned.filter((_, index) => ticketIssues[index].length > 0);

    // Bewusst NICHT der volle planningPrompt (Konzept, Beschlussregister,
    // Backlog, Kundenanfragen, Sprint-Historie – alles schon in den ersten
    // Entwurf eingeflossen) und auch nicht der komplette erste Entwurf: Das
    // Modell soll hier nur noch die paar zu großen Tickets zerlegen, nicht
    // den ganzen Sprint neu durchdenken. Genau diese unnötig aufgeblähten
    // Refinement-Prompts liefen zuletzt öfter in den Timeout (5 Min. reichten
    // nicht, siehe Job-Log) – vermutlich weil das Modell bei so vielen
    // gleichzeitig zu beachtenden Dingen entsprechend lange "denkt". Ein
    // knapper Prompt mit nur den betroffenen Tickets braucht spürbar weniger
    // davon. Die bereits passenden Tickets übernehmen wir unten unverändert
    // aus dem ersten Entwurf, ohne dass das Modell sie erneut ausgeben muss.
    const refined = await runAgent({
      agent,
      projectId,
      kind: "sprint_refinement",
      headline: `Zerlegt zu große Tickets für Sprint ${nextNumber}`,
      maxTokens: 5000,
      // Zerlegen ist ein Sonderfall des ohnehin ueppigen DEFAULT_TIMEOUT_MS
      // (siehe worker/agentRun.ts): selbst der schlanke Prompt hier verlangt
      // dem Modell noch reichlich Ueberlegung ab (mehrere neue, in sich
      // stimmige Teiltickets statt einer einzelnen Antwort). Mehr Luft statt
      // eines weiteren Fehlschlags, der das Ticket nur unzerlegt zurücklässt.
      timeoutMs: 480_000,
      system: `${TEAM_GRUNDREGELN}\n\nDu bist ${agent.name}, Product Owner. Du zerlegst zu große Tickets in kleinere, eigenständig umsetzbare Teiltickets. Du antwortest ausschließlich mit einem JSON-Objekt.`,
      prompt: `# Zu große Tickets aus dem Sprint-Entwurf für Sprint ${nextNumber}\n${JSON.stringify(badTickets, null, 2)}\n\n# Verstöße gegen die harten Ticketgrenzen\n${issues.join("\n")}\n\nZerlege NUR diese zu großen Tickets, je in 2–4 kleinere, eigenständig umsetzbare Teiltickets (Schätzung je 1–3, höchstens ${MAX_FILES_PER_TICKET} Dateien, höchstens ${MAX_CRITERIA_PER_TICKET} Akzeptanzkriterien). Die übrigen ${goodTickets.length} Tickets dieses Sprints sind bereits in Ordnung und werden unverändert übernommen – wiederhole sie nicht.\n\nAntworte nur mit diesem JSON-Objekt, "tickets" enthält NUR die neuen Teiltickets (höchstens ${Math.max(remainingSlots - goodTickets.length, 0)} insgesamt):\n{\n  "tickets": [\n    {\n      "title": "ein einzelnes, kleines Ergebnis",\n      "description": "was genau zu tun ist",\n      "acceptanceCriteria": ["konkret prüfbares Kriterium"],\n      "likelyFiles": ["relativer/pfad.ts"],\n      "type": "FEATURE | BUG | INTEGRATION | CHORE",\n      "priority": "LOW | MEDIUM | HIGH | URGENT",\n      "estimate": 1,\n      "role": "BACKEND | FRONTEND | QA | DEVOPS",\n      "critical": false\n    }\n  ]\n}`,
    });
    const refinedParsed = extractJsonObject(refined.text);
    const splitTickets = Array.isArray(refinedParsed.tickets) ? (refinedParsed.tickets as PlannedTicket[]) : [];
    planned = [...goodTickets, ...splitTickets].slice(0, remainingSlots);
  }

  const goal = String(parsed.goal ?? "").trim() || `Sprint ${nextNumber}`;

  // "Fertig" ist eine Aussage des Modells nur über Konzept und Anforderungen.
  // Zurückgestellte Tickets sind davon unabhängig offene Arbeit – ein Modell,
  // das sie im Prompt übersieht oder ignoriert, darf den Auftrag nicht für
  // erledigt erklären, solange noch welche warten.
  const done = pulled.length === 0 && parsed.done === true;

  if (done || (planned.length === 0 && pulled.length === 0)) {
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

  // Zurückgestellte Tickets existieren schon (samt Anlauf-Historie/-Budget) –
  // sie brauchen nur die Zuordnung zum neuen Sprint, keine Neuerstellung.
  const carriedOverTickets = await Promise.all(
    pulled.map((ticket) => prisma.ticket.update({ where: { id: ticket.id }, data: { sprintId: sprint.id } })),
  );
  if (carriedOverTickets.length > 0) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "tickets_reclaimed",
      detail: `${carriedOverTickets.length} zurückgestellte ${carriedOverTickets.length === 1 ? "Ticket" : "Tickets"} wieder in Sprint ${sprint.number} aufgenommen: ${carriedOverTickets.map((ticket) => `„${ticket.title}"`).join(", ")}.`,
    });
  }

  const createdTickets: Ticket[] = [];
  for (const item of planned) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;

    const role = roleForTicket(typeof item.role === "string" ? item.role : null);
    const assignee = await agentForRole(projectId, role);
    const criteria = stringList(item.acceptanceCriteria, MAX_CRITERIA_PER_TICKET);
    const likelyFiles = stringList(item.likelyFiles, MAX_FILES_PER_TICKET);
    const dependencies = stringList(item.dependsOn, MAX_TICKETS_PER_SPRINT);

    // Ordnet das Ticket ggf. der Kundenanfrage zu, aus der es stammt – per
    // `updateMany` mit Status-Bedingung: Ein anderes Projekt desselben Kunden
    // könnte dieselbe Anfrage in genau diesem Moment ebenfalls triagieren, nur
    // wer sie zuerst als NEW/TRIAGED erwischt, darf sie umwandeln.
    const anfrageNr = Number(item.anfrageNr);
    const matchedRequest = Number.isInteger(anfrageNr) ? openRequests[anfrageNr - 1] : undefined;
    let sourceRequestId: string | null = null;
    if (matchedRequest) {
      const claimed = await prisma.supportRequest.updateMany({
        where: { id: matchedRequest.id, status: { in: ["NEW", "TRIAGED"] } },
        data: { status: "CONVERTED", handledById: agent.id },
      });
      if (claimed.count === 1) sourceRequestId = matchedRequest.id;
    }

    const baseDescription = typeof item.description === "string" ? item.description.trim() : "";
    const structuredDescription = [
      baseDescription,
      criteria.length > 0 ? `## Akzeptanzkriterien\n${criteria.map((entry) => `- ${entry}`).join("\n")}` : "",
      likelyFiles.length > 0 ? `## Voraussichtliche Dateien\n${likelyFiles.map((entry) => `- ${entry}`).join("\n")}` : "",
      dependencies.length > 0 ? `## Abhängigkeiten\n${dependencies.map((entry) => `- ${entry}`).join("\n")}` : "",
      matchedRequest && sourceRequestId
        ? `## Quelle\nKundenanfrage${matchedRequest.fromContact ? ` von ${matchedRequest.fromContact}` : ""}: ${matchedRequest.subject ?? matchedRequest.body.slice(0, 120)}`
        : "",
    ].filter(Boolean).join("\n\n");

    const ticket = await prisma.ticket.create({
      data: {
        projectId,
        sprintId: sprint.id,
        sourceRequestId,
        title,
        description: structuredDescription || null,
        type: asTicketType(item.type),
        priority: asPriority(item.priority),
        estimate: Number.isFinite(Number(item.estimate)) ? Math.min(3, Math.max(1, Number(item.estimate))) : 1,
        isCritical: item.critical === true,
        assigneeId: assignee?.id ?? null,
      },
    });
    createdTickets.push(ticket);

    if (sourceRequestId && matchedRequest) {
      await logActivity({
        projectId,
        actor: agent.name,
        agentId: agent.id,
        action: "support_request_converted",
        detail: `Kundenanfrage „${matchedRequest.subject ?? matchedRequest.body.slice(0, 80)}" zu Ticket „${title}" überführt.`,
        ticketId: ticket.id,
        supportRequestId: matchedRequest.id,
      });
    }
  }

  // Sprint-Plan auch im Repo ablegen: Der Auftraggeber soll den Plan dort
  // finden, wo auch das Ergebnis liegt, nicht nur in der Oberflaeche.
  if (project.workspacePath) {
    const planDoc =
      `# Sprint ${sprint.number}\n\n**Ziel:** ${goal}\n\n**Geplant von:** ${agent.name} (Product Owner)\n\n## Tickets\n\n` +
      [
        ...carriedOverTickets.map((ticket) => formatTicketDoc(ticket, "zurückgestellt, wieder aufgenommen")),
        ...createdTickets.map((ticket) => formatTicketDoc(ticket)),
      ].join("\n\n");

    await writeFiles(project.workspacePath, [
      { path: `docs/sprints/sprint-${sprint.number}-plan.md`, content: planDoc },
    ]);
    await commitAll(project.workspacePath, {
      message: `Sprint ${sprint.number} geplant: ${goal}`,
      authorName: agent.name,
    });
  }

  const allTickets = [...carriedOverTickets, ...createdTickets];
  await logActivity({
    projectId,
    actor: agent.name,
    agentId: agent.id,
    action: "sprint_planned",
    detail:
      `Sprint ${sprint.number} geplant – Ziel: ${goal} (${allTickets.length} Tickets` +
      `${carriedOverTickets.length > 0 ? `, davon ${carriedOverTickets.length} wieder aufgenommen` : ""})`,
  });

  helpers.logger.info(`Sprint ${sprint.number} für Projekt ${projectId} geplant (${reason}).`);
  await continueSprint(projectId, sprint.id);
};

export default sprintPlanning;
