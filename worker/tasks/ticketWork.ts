// Ein Ticket von der Planung bis zum Review – der eigentliche Arbeitstag.
//
// Drei Schritte, drei Kollegen, drei Belege: Der Planning-Agent schreibt den
// Umsetzungsplan ins Ticket, der zuständige Coding-Agent ändert Dateien im
// Repo und committet unter seinem Namen, danach schaut QA auf den Diff. Erst
// wenn QA zufrieden ist, gilt das Ticket als fertig; kritische Tickets landen
// zusätzlich beim Menschen zur Freigabe.
//
// Alles bewusst in EINEM Job statt in drei: So kann kein anderer Agent
// dazwischen ins selbe Repo schreiben, und ein Ticket ist entweder ganz
// bearbeitet oder erkennbar hängengeblieben.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { commitAll, gitShow, readRelevantSourceContext, repoOverview, writeFiles } from "@/lib/workspace";
import { agentForRole, roleForTicket } from "@/lib/team";
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { optionsFromAgent, type ClarificationOption } from "@/lib/clarificationOptions";
import { checkFailed, detectCheckTargets, formatCheckResults, runChecks, type CheckRunResult } from "@/lib/testRun";
import type { Agent } from "@/generated/prisma/client";
import { AgentRunError, logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject } from "../orchestration";
import { openClarification } from "../clarification";
import { enqueueAgentJob } from "../queue";
import { runImplementationLoop, type AttemptTrace } from "../agentToolLoop";
import type { TicketWorkPayload } from "../taskTypes";

/// Nach so vielen Anläufen IN FOLGE hört das Team auf, ein Ticket allein lösen
/// zu wollen, und holt den Menschen dazu – wie ein Kollege, der nach dem
/// zweiten Versuch fragt statt weiter zu probieren. Zählt innerhalb einer
/// Nacharbeits-Kette (Job-Payload) und beginnt nach jedem Beschluss neu; die
/// Obergrenze über das ganze Ticketleben ist `Ticket.attemptBudget`.
const MAX_ATTEMPTS = 2;

/// So viele Anläufe bleiben im Kurzprotokoll des Tickets stehen. Der nächste
/// Anlauf soll den Weg der letzten Versuche kennen – nicht die ganze
/// Leidensgeschichte durchs Kontextfenster schleppen.
const ATTEMPT_LOG_KEEP = 4;
const ATTEMPT_LOG_SEPARATOR = "\n\n---\n\n";

/// Schreibt fest, was ein Anlauf getan hat. Das ist die Antwort auf den
/// teuersten Fehler des bisherigen Ablaufs: Jeder neue Anlauf bekam exakt
/// denselben Prompt wie der erste und fing bei null an – dieselben Dateien
/// gelesen, dieselbe Sackgasse, dieselbe Begründung. Ein Mensch macht da
/// weiter, wo er aufgehört hat; dafür muss irgendwo stehen, wo das war.
async function recordAttempt(input: {
  ticketId: string;
  attempt: number;
  agentName: string;
  outcome: string;
  trace?: AttemptTrace;
}): Promise<void> {
  const { trace } = input;
  const lines = [`### Anlauf ${input.attempt} – ${input.agentName}`, `Ergebnis: ${input.outcome}`];
  if (trace) {
    if (trace.wrote.length > 0) lines.push(`Geschrieben: ${trace.wrote.join(", ")}`);
    if (trace.read.length > 0) lines.push(`Gelesen: ${trace.read.slice(0, 15).join(", ")}`);
    if (trace.searched.length > 0) lines.push(`Gesucht nach: ${trace.searched.slice(0, 10).join(", ")}`);
    if (trace.commands.length > 0) lines.push(`Ausgeführt: ${trace.commands.slice(0, 8).join(" · ")}`);
    if (trace.lastText) lines.push(`Zuletzt gesagt: „${trace.lastText.slice(0, 400)}"`);
    lines.push(`(${trace.turns} Arbeitsschritte)`);
  }

  const current = await prisma.ticket.findUnique({ where: { id: input.ticketId }, select: { attemptLog: true } });
  const entries = current?.attemptLog ? current.attemptLog.split(ATTEMPT_LOG_SEPARATOR) : [];
  entries.push(lines.join("\n"));
  await prisma.ticket.update({
    where: { id: input.ticketId },
    data: { attemptLog: entries.slice(-ATTEMPT_LOG_KEEP).join(ATTEMPT_LOG_SEPARATOR) },
  });
}

/// Das Kurzprotokoll als Prompt-Abschnitt. Beim ersten Anlauf leer – da gibt es
/// nichts zu wiederholen.
function attemptHistorySection(attemptLog: string | null, reason: string, attempt: number): string {
  if (attempt <= 1 || !attemptLog?.trim()) return "";
  return `## Was frühere Anläufe an diesem Ticket schon probiert haben
Das hier ist Anlauf ${attempt}. Die vorigen sind gescheitert oder ohne Änderung geblieben. Lies das, bevor du anfängst, und geh nicht denselben Weg noch einmal.

${attemptLog.trim()}

Auslöser für diesen Anlauf: ${reason}

Kommst du wieder zu dem Schluss, dass nichts zu tun ist, ist das nach ${attempt - 1} Anläufen keine brauchbare Antwort mehr. Geh dann die Akzeptanzkriterien einzeln durch und belege mit read_file/run_command, woran du siehst, dass jedes einzelne erfüllt ist – oder setze um, was fehlt.

`;
}

function clipForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} Zeichen für diesen Arbeitsschritt ausgeblendet)`;
}

/// Ab so vielen bereits entschiedenen Klärungen für dasselbe Ticket bekommt
/// eine neue Klärung einen Hinweis auf die Vorgeschichte mit auf den Weg.
/// Ohne den sieht weder der Scrum Master bei der Vorlage noch der Auftraggeber
/// beim Entscheiden, dass "nochmal versuchen" hier schon mehrfach nichts
/// gebracht hat – die Klärung wirkt jedes Mal wie die erste (siehe
/// clarificationTriage.ts, wo derselbe Schwellenwert das automatische
/// Entscheiden abschaltet; hier geht es zusätzlich darum, dass auch ein
/// Mensch die Wiederholung sieht, statt wieder "resume" zu wählen).
const REPEAT_HISTORY_THRESHOLD = 2;

async function repeatHistoryNote(ticketId: string): Promise<string> {
  const priorDecisions = await prisma.clarification.count({
    where: { ticketId, status: { in: ["DECIDED", "WITHDRAWN"] } },
  });
  if (priorDecisions < REPEAT_HISTORY_THRESHOLD) return "";
  return (
    `ACHTUNG: Für dieses Ticket wurden schon ${priorDecisions} Klärungen entschieden, ohne dass es fertig wurde. ` +
    `Ein weiteres "nochmal versuchen" hat bisher nichts geändert. Prüfe ernsthaft, ob "Ticket abschließen" ` +
    `der richtige Weg ist, statt dieselbe Frage erneut zu stellen.\n\n`
  );
}

/// Markiert im Ticket-Ergebnis die Liste abgelehnter Dateien – reine
/// Information für den Menschen (siehe Nachweise), keine Erinnerung für einen
/// erneuten Anlauf mehr: Innerhalb eines Tool-Loops (worker/agentToolLoop.ts)
/// sieht der Agent eine Ablehnung sofort als Tool-Ergebnis und korrigiert im
/// selben Anlauf – ein zweiter Ticket-Versuch startet deshalb ohne
/// Sonderbehandlung frueherer Ablehnungen.
const REJECTED_FILES_MARKER = "Abgelehnte Änderungen:";

function formatRejectedFiles(rejected: { path: string; reason: string }[]): string {
  return `${REJECTED_FILES_MARKER}\n${rejected.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}`;
}

interface SplitTicket {
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  likelyFiles?: unknown;
  role?: unknown;
}

function splitStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, limit)
    : [];
}

async function splitTicketAfterTokenLimit({
  projectId,
  ticket,
  plan,
  failedAgentId,
}: {
  projectId: string;
  ticket: {
    id: string;
    sprintId: string | null;
    title: string;
    description: string | null;
    type: "FEATURE" | "BUG" | "INTEGRATION" | "CHORE";
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    isCritical: boolean;
  };
  plan: string;
  failedAgentId: string;
}): Promise<boolean> {
  if (!ticket.sprintId) return false;
  const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
  if (!productOwner) return false;

  const context = await buildProjectContext(projectId, {
    includeRepo: false,
    includeBoard: false,
    compact: true,
    focus: `${ticket.title}\n${ticket.description ?? ""}`,
    ticketId: ticket.id,
  });
  const split = await runAgent({
    agent: productOwner,
    projectId,
    ticketId: ticket.id,
    sprintId: ticket.sprintId,
    kind: "ticket_split",
    headline: `Zerlegt Ticket „${ticket.title}" nach Token-Limit`,
    maxTokens: 5000,
    system: `${TEAM_GRUNDREGELN}\n\nDu bist ${productOwner.name}, Product Owner. Du zerlegst einen technisch zu großen Arbeitsschritt. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `${context}

## Zu großes Ticket
${ticket.title}
${clipForPrompt(ticket.description ?? "", 6000)}

## Bisheriger Umsetzungsplan
${clipForPrompt(plan, 8000)}

Die Umsetzung hat trotz begrenztem, relevantem Quellcodekontext das Ausgabelimit erreicht. Zerlege das Ticket in 2–5 aufeinanderfolgende, eigenständig umsetzbare Teiltickets. Jedes Teilticket hat genau ein Ergebnis, 1–4 Akzeptanzkriterien, voraussichtlich höchstens 4 geänderte oder neue Dateien und eine Schätzung von 1–3. Kein Teilticket darf nur „Rest umsetzen" heißen.

Antworte nur so:
{
  "tickets": [{
    "title": "kleines Ergebnis",
    "description": "konkreter Umfang",
    "acceptanceCriteria": ["prüfbares Kriterium"],
    "likelyFiles": ["relativer/pfad.ts"],
    "role": "BACKEND | FRONTEND | QA | DEVOPS"
  }]
}`,
  });

  const parsed = extractJsonObject(split.text);
  const parts = Array.isArray(parsed.tickets) ? (parsed.tickets as SplitTicket[]).slice(0, 5) : [];
  const valid = parts.filter((part) => {
    const title = String(part.title ?? "").trim();
    const criteria = splitStringList(part.acceptanceCriteria, 5);
    const files = splitStringList(part.likelyFiles, 5);
    return title.length > 0 && criteria.length >= 1 && criteria.length <= 4 && files.length >= 1 && files.length <= 4;
  });
  if (valid.length < 2) return false;

  const prepared = [];
  for (const part of valid) {
    const role = roleForTicket(typeof part.role === "string" ? part.role : null);
    const assignee = await agentForRole(projectId, role);
    const criteria = splitStringList(part.acceptanceCriteria, 4);
    const files = splitStringList(part.likelyFiles, 4);
    prepared.push({
      title: String(part.title).trim(),
      description: [
        String(part.description ?? "").trim(),
        `## Akzeptanzkriterien\n${criteria.map((entry) => `- ${entry}`).join("\n")}`,
        `## Voraussichtliche Dateien\n${files.map((entry) => `- ${entry}`).join("\n")}`,
        `## Herkunft\nAutomatisch zerlegt aus „${ticket.title}", nachdem dessen Modellausgabe das Token-Limit erreicht hat.`,
      ].filter(Boolean).join("\n\n"),
      assigneeId: assignee?.id ?? failedAgentId,
    });
  }

  const [first, ...rest] = prepared;
  await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticket.id },
      data: { title: first.title, description: first.description, estimate: 2, assigneeId: first.assigneeId, plan: null, result: null, status: "BACKLOG" },
    }),
    ...rest.map((part) => prisma.ticket.create({
      data: {
        projectId,
        sprintId: ticket.sprintId,
        title: part.title,
        description: part.description,
        type: ticket.type,
        priority: ticket.priority,
        estimate: 2,
        isCritical: ticket.isCritical,
        assigneeId: part.assigneeId,
      },
    })),
    prisma.agent.update({ where: { id: failedAgentId }, data: { status: "IDLE" } }),
  ]);
  await logActivity({
    projectId,
    ticketId: ticket.id,
    actor: productOwner.name,
    agentId: productOwner.id,
    action: "ticket_split",
    detail: `„${ticket.title}" nach Token-Limit automatisch in ${prepared.length} kleine Tickets zerlegt.`,
  });
  await continueSprint(projectId, ticket.sprintId);
  return true;
}

function slugForFile(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "pruefung";
}

interface AutomaticVerification {
  commit: NonNullable<Awaited<ReturnType<typeof commitAll>>>;
  results: CheckRunResult[];
  allPassed: boolean;
}

/// Wird angestoßen, wenn der Umsetzer keine Dateiänderung geliefert hat und
/// auch keine fachliche Rückfrage stellt – wie im Fall, der diese Funktion
/// ausgelöst hat: ein Ticket, das nur "prüfen, ob der Export funktioniert"
/// verlangt, kein Modell kann das aus dem Diff heraus beantworten. Statt dem
/// Auftraggeber die Frage "wurde getestet?" vorzulegen, lässt Scrumy es
/// tatsächlich laufen (siehe src/lib/testRun.ts) und hält das Ergebnis als
/// eigenen, von QA verantworteten Commit fest – dieselbe Nachvollziehbarkeit
/// wie bei jedem Code-Commit, nur ist der Beleg hier ein echter Testlauf statt
/// eines Diffs.
///
/// Gibt `null` zurück, wenn es nichts zu prüfen gab (kein package.json mit
/// test-/lint-/build-Skript) oder der Runner selbst nicht erreichbar war
/// (Docker-Socket fehlt) – dann bleibt der bisherige Weg über eine Klärung
/// der richtige, weil wirklich niemand im Team das beantworten kann.
async function attemptAutomaticVerification({
  dir,
  projectId,
  ticket,
  reviewer,
}: {
  dir: string;
  projectId: string;
  ticket: { id: string; title: string };
  reviewer: Agent;
}): Promise<AutomaticVerification | null> {
  const targets = await detectCheckTargets(dir);
  if (targets.length === 0) return null;

  const results = await runChecks(projectId, targets);
  if (results.every((result) => result.unavailable)) return null;

  const allPassed = results.every((result) => !checkFailed(result));
  const docPath = `docs/technik/pruefung-${slugForFile(ticket.title)}.md`;
  const docContent = `# Automatische Prüfung: ${ticket.title}

Von Scrumy automatisch ausgeführt, kein Modellurteil: \`npm ci\` (oder \`npm install\` ohne Lockfile), danach \`npm test\`/\`npm run lint\`/\`npm run build\`, je nachdem was das jeweilige package.json anbietet.

${formatCheckResults(results)}
`;
  await writeFiles(dir, [{ path: docPath, content: docContent }]);
  const commit = await commitAll(dir, {
    authorName: reviewer.name,
    message:
      `Automatische Prüfung dokumentiert: ${ticket.title}\n\n` +
      (allPassed
        ? "Alle gefundenen Prüf-Skripte liefen durch (Exit-Code 0)."
        : "Mindestens ein Prüf-Skript ist fehlgeschlagen – Details im Dokument.") +
      `\n\nTicket: ${ticket.title} (${ticket.id})\nGeprüft von: ${reviewer.name}`,
  });
  // Kein Commit trotz Ergebnissen ist nur bei einem bereits identischen
  // Dokument aus einem vorigen Anlauf denkbar (Wiederholung nach Requeue) –
  // dann zaehlt trotzdem als Beleg, nur eben ohne neuen Commit.
  if (!commit) return null;

  return { commit, results, allPassed };
}

/// Billige Vorpruefung, bevor Planung UND Umsetzung (der teure Modellaufruf
/// mit vollem Quellcode-Kontext) angestossen werden: Manche Tickets sind
/// laengst erfuellt – etwa ein Teilticket nach automatischer Zerlegung, dessen
/// Arbeit ein anderes Ticket zwischenzeitlich schon erledigt hat, oder ein
/// wiederholter Anlauf nach "Nochmal versuchen", bei dem der Code laengst
/// stimmt. Nur wenn das Ticket eine erkennbare Akzeptanzkriterien-Liste hat
/// und es ueberhaupt passenden Bestandscode gibt, sonst normaler Ablauf.
/// Antwortet das Modell nicht eindeutig mit "satisfied", passiert nichts –
/// der normale (teure) Ablauf laeuft unveraendert weiter. Kritische Tickets
/// werden nie automatisch geschlossen, die brauchen ohnehin menschliche
/// Freigabe.
async function checkAlreadySatisfied({
  agent,
  projectId,
  ticket,
  dir,
}: {
  agent: Agent;
  projectId: string;
  ticket: { id: string; title: string; description: string | null; sprintId: string | null };
  dir: string;
}): Promise<{ satisfied: boolean; reason: string } | null> {
  const focus = `${ticket.title}\n${ticket.description ?? ""}`;
  const sourceContext = await readRelevantSourceContext(dir, focus, { maxChars: 10_000, maxFiles: 6 });
  if (sourceContext.startsWith("(keine anhand des Tickets relevante Quelldatei gefunden)")) return null;

  const checked = await runAgent({
    agent,
    projectId,
    ticketId: ticket.id,
    sprintId: ticket.sprintId ?? undefined,
    kind: "acceptance_precheck",
    headline: `Prüft, ob „${ticket.title}" schon erfüllt ist`,
    maxTokens: 300,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}. Du prüfst NUR, ob ein Ticket anhand des bereits vorhandenen Codes schon vollständig erfüllt ist – du änderst nichts und schlägst nichts vor. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `## Ticket
${ticket.title}
${clipForPrompt(ticket.description ?? "", 3000)}

## Bestehender Code (zum Ticket passende Auswahl)
${sourceContext}

Sind ALLE Akzeptanzkriterien des Tickets bereits durch genau diesen Code erfüllt, ganz ohne weitere Änderung? Sei konservativ: Bei Zweifel, bei Kriterien, die sich nicht rein am Code ablesen lassen (z.B. Laufzeitverhalten), oder wenn auch nur ein Kriterium fehlt, antworte mit "satisfied": false.

Antworte nur so:
{"satisfied": true|false, "reason": "ein Satz Begründung"}`,
  });

  const parsed = extractJsonObject(checked.text);
  if (typeof parsed.satisfied !== "boolean") return null;
  return { satisfied: parsed.satisfied, reason: String(parsed.reason ?? "").trim().slice(0, 400) };
}

const ticketWork: Task<"ticketWork"> = async (payload: TicketWorkPayload, helpers) => {
  const { agentId, projectId, ticketId, reason } = payload;
  const attempt = payload.attempt ?? 1;

  const project = await loadWorkingProject(projectId);
  if (!project) {
    helpers.logger.info(`Projekt ${projectId} ist nicht aktiv – Ticket ${ticketId} bleibt liegen.`);
    return;
  }
  if (!project.workspacePath) {
    await openClarification({
      projectId,
      scope: "PROJECT",
      trigger: "no_workspace",
      question: "Das Team hat kein Arbeitsverzeichnis – der erste Arbeitstag ist nie durchgelaufen. Neu anfangen?",
      context: `Ticket „${ticketId}" sollte umgesetzt werden, aber es gibt kein Repository. Ohne Kickoff (Repo anlegen, Auftragsunterlagen ablegen) kann niemand committen.`,
      options: [
        {
          key: "resume",
          label: "Kickoff nachholen",
          detail: "Scrumy stößt den nächsten fälligen Schritt an – das ist dann der erste Arbeitstag.",
          effect: "resume",
        },
        { key: "stop", label: "Team anhalten", effect: "stop" },
      ],
      prepare: false,
    });
    return;
  }
  const dir = project.workspacePath;

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { sprint: true } });
  if (!ticket || ticket.status === "DONE") {
    if (ticket?.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  const implementer = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  // --- 0a. Anlauf-Budget --------------------------------------------------
  // Die einzige Stelle, an der eine Dauerschleife wirklich endet. `attempt`
  // aus dem Payload zaehlt nur innerhalb einer Nacharbeits-Kette und begann
  // bei jedem Nachziehen aus dem Sprint wieder bei 1 – ein Ticket kam so auf
  // 16 Anlaeufe, waehrend MAX_ATTEMPTS auf 2 stand. Massgeblich ist deshalb
  // der Zaehler am Ticket selbst.
  if (ticket.attempts >= ticket.attemptBudget) {
    helpers.logger.info(`Ticket ${ticket.title}: Anlauf-Budget aufgebraucht (${ticket.attempts}) – kein weiterer Versuch.`);
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }
  const totalAttempt = ticket.attempts + 1;

  // --- 0. Billige Vorpruefung: ist das Ticket schon erfuellt? ---------------
  // Nur beim allerersten Blick auf das Ticket sinnvoll ("hat ein früheres
  // Ticket das nebenbei schon erledigt?") – bei einem Retry/Rework wissen wir
  // es bereits: der vorige Anlauf selbst (QA-Review oder ein leerer Diff) hat
  // gerade erst festgestellt, dass es NICHT erfüllt ist. Ohne dieses Gate lief
  // die Prüfung bei einem haengenden Ticket bei jedem einzelnen Anlauf erneut
  // – bei einem beobachteten Dauerschleifen-Fall 27 Mal für dasselbe Ticket,
  // gut 7 der insgesamt ca. 51 Modell-Minuten reine Verschwendung. Das Gate
  // haengt bewusst am Ticket-Zaehler, nicht am Payload: Der sprang beim
  // Nachziehen aus dem Sprint auf 1 zurueck und liess die Vorpruefung fuer
  // dasselbe Ticket erneut 12 Mal laufen.
  if (totalAttempt === 1 && !ticket.isCritical && /##\s*Akzeptanzkriterien/i.test(ticket.description ?? "")) {
    const already = await checkAlreadySatisfied({ agent: implementer, projectId, ticket, dir });
    if (already?.satisfied) {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: "DONE", result: `Bereits erfüllt (automatisch geprüft, kein neuer Anlauf nötig): ${already.reason}` },
      });
      await logActivity({
        projectId,
        ticketId,
        actor: implementer.name,
        agentId: implementer.id,
        action: "ticket_done",
        detail: `„${ticket.title}" ist bereits erfüllt – automatisch vor der Umsetzung erkannt, keine Planung/Umsetzung nötig (${already.reason})`,
      });
      if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
      return;
    }
  }

  const ticketHead =
    `## Ticket\n${ticket.title}\nTyp: ${TICKET_TYPE_LABEL[ticket.type]} · Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
    `${ticket.isCritical ? " · kritisch (braucht menschliche Freigabe)" : ""}\n\n${clipForPrompt(ticket.description ?? "", 6000)}`;

  // Der Zaehler steigt hier, nicht erst am Ende: Auch ein Anlauf, der gleich
  // abstuerzt, hat einen Versuch verbraucht – sonst zaehlt ausgerechnet die
  // Schleife nicht mit, die man begrenzen will.
  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "IN_PROGRESS", attempts: totalAttempt },
  });
  await logActivity({
    projectId,
    ticketId,
    actor: implementer.name,
    agentId: implementer.id,
    action: attempt === 1 ? "ticket_started" : "ticket_reworked",
    detail:
      (attempt === 1 ? `„${ticket.title}" übernommen` : `„${ticket.title}" – Nacharbeit nach QA-Review`) +
      ` (Anlauf ${totalAttempt} von ${ticket.attemptBudget})`,
  });

  const focus = `${ticket.title}\n${ticket.description ?? ""}`;
  const context = await buildProjectContext(projectId, {
    includeRepo: false,
    includeBoard: false,
    compact: true,
    focus,
    ticketId: ticket.id,
  });

  // --- 1. Planung -----------------------------------------------------------
  let plan = ticket.plan;
  if (!plan) {
    const planner = (await agentForRole(projectId, "PLANNING")) ?? implementer;
    const planned = await runAgent({
      agent: planner,
      projectId,
      ticketId,
      sprintId: ticket.sprintId ?? undefined,
      kind: "ticket_plan",
      headline: `Plant Ticket „${ticket.title}"`,
      maxTokens: 3000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${planner.name} und planst die Umsetzung eines Tickets für ${implementer.name}.`,
      prompt: `${context}

${ticketHead}

## Relevanter Repository-Überblick
${await repoOverview(dir, 160, focus)}

Schreibe einen knappen Umsetzungsplan als Markdown-Liste: welche Dateien angelegt oder geändert werden, in welcher Reihenfolge, und woran man erkennt, dass das Ticket erfüllt ist. Keine Codeblöcke, keine Zeitschätzung.`,
    });

    plan = planned.text;
    await prisma.ticket.update({ where: { id: ticketId }, data: { plan } });
    await logActivity({
      projectId,
      ticketId,
      actor: planner.name,
      agentId: planner.id,
      action: "ticket_planned",
      detail: `Umsetzungsplan für „${ticket.title}" geschrieben`,
    });
  }

  // --- 2. Umsetzung -----------------------------------------------------
  // Kein vorbereiteter Kontext-Dump und kein starres Blockformat mehr: Der
  // Agent arbeitet in einem Werkzeug-Loop (siehe worker/agentToolLoop.ts) –
  // liest/sucht, was er braucht, ändert gezielt mit edit_file/write_file,
  // lässt bei Bedarf selbst Tests/Build laufen (run_command) und ruft erst
  // finish, wenn alles erledigt ist. Dateien sind zu diesem Zeitpunkt bereits
  // auf der Platte (jedes Werkzeug schreibt sofort) – committet wird gleich
  // unten in einem Schritt, wie zuvor.
  const planForPrompt = clipForPrompt(plan, 8000);
  let loopResult;
  try {
    loopResult = await runImplementationLoop({
      agent: implementer,
      projectId,
      dir,
      ticketId,
      sprintId: ticket.sprintId ?? undefined,
      system: `${TEAM_GRUNDREGELN}

Du bist ${implementer.name} und setzt das Ticket im Repository um, mit echten Werkzeugen (lesen, suchen, schreiben, Befehle ausführen) – wie ein Kollege am Terminal, nicht mit einer einzigen vorbereiteten Antwort. Ruf "finish" nie zusammen mit einem anderen Werkzeug im selben Schritt auf.`,
      initialPrompt: `${context}

${ticketHead}

${attemptHistorySection(ticket.attemptLog, reason, totalAttempt)}## Umsetzungsplan
${planForPrompt}

## Repository-Überblick
${await repoOverview(dir, 160, focus)}

Die Auftragsunterlagen (docs/konzept.md, docs/anforderungen.md, docs/verstaendnis.md und docs/sprints/…) sind der eingefrorene Auftrag – write_file/edit_file lehnen Änderungen daran ohnehin ab. Lege dabei auch keine eigene Markdown-Dokumentation an (z.B. unter docs/technik/) – das kostet in jedem folgenden Ticket erneut Kontext-Budget, ohne dass der Auftraggeber danach gefragt hat. Dokumentation ist nur dann Teil dieses Tickets, wenn genau das der Auftrag ist.

Setze ausschließlich dieses kleine Ticket um. Nutze read_file/list_files/search_files, um dir den nötigen Kontext selbst zu holen, statt zu raten.

Verlangt das Ticket nur eine Prüfung eines bereits bestehenden Stands (z.B. "testen, ob X funktioniert"): Führe die Prüfung mit run_command wirklich aus und fasse das Ergebnis in "summary" zusammen, statt eine Klärung zu eröffnen. Nur wenn wirklich gar nichts zu tun ist, ruf finish ohne Dateiänderungen auf.

Wenn Auftrag und Anforderungen sich an einer Stelle widersprechen oder etwas Wesentliches offen lassen, das du nicht selbst entscheiden darfst (Fachlogik, Datenhaltung, Kosten, Rechte): Erfinde nichts. Setze um, was zweifelsfrei ist, und stelle die Frage im "finish"-Parameter "clarification" – der Auftraggeber entscheidet, und das Team arbeitet danach mit dem Beschluss weiter. Gib dazu in "clarificationOptions" zwei bis vier fachliche Wege an (Titel + kurze Erklärung mit Für und Wider) – die Möglichkeiten, die DU siehst (welcher Server, welches Datenmodell, welche Bibliothek), nicht „nochmal versuchen" oder „abbrechen", die kennt Scrumy selbst.`,
      maxTokensPerTurn: 4000,
    });
  } catch (error) {
    if (
      error instanceof AgentRunError &&
      error.code === "TOKEN_LIMIT" &&
      await splitTicketAfterTokenLimit({ projectId, ticket, plan, failedAgentId: implementer.id })
    ) {
      helpers.logger.info(`Ticket ${ticket.title} war zu groß und wurde automatisch zerlegt.`);
      return;
    }
    // Alles andere ist ein unerwarteter Absturz mitten im Werkzeug-Loop (z.B.
    // eine Git-Operation, deren Ausgabe ein Puffer-Limit reißt – beobachtet
    // im OnwPhoto-Projekt: node_modules ohne .gitignore committet, danach
    // 'stdout maxBuffer length exceeded'). Ohne Fangnetz hier wirft graphile-
    // worker den Job nach MAX_ATTEMPTS einfach weg: das Ticket bleibt für
    // immer auf IN_PROGRESS stehen, ohne dass irgendwo ein Fehler sichtbar
    // wird. Lieber wie einen regulären Fehlschlag behandeln – Mensch schaut
    // drauf, statt dass der Job spurlos verschwindet.
    const message = error instanceof Error ? error.message : String(error);
    helpers.logger.error(`Ticket ${ticket.title}: Umsetzungsloop abgestürzt – ${message}`);
    await recordAttempt({
      ticketId,
      attempt: totalAttempt,
      agentName: implementer.name,
      outcome: `abgestürzt: ${message.slice(0, 200)}`,
      trace: (error as { attemptTrace?: AttemptTrace }).attemptTrace,
    });
    await requestHumanReview(
      projectId,
      ticketId,
      ticket.title,
      `Unerwarteter Fehler beim Umsetzen (Anlauf ${attempt}): ${message.slice(0, 500)}`,
      true,
    );
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  // Was dieser Anlauf getan hat, gehoert ins Ticket, BEVOR irgendein Zweig
  // aussteigt – auch ein abgebrochener Anlauf (Turn-/Zeitlimit, Arbeitsstand
  // verworfen) ist fuer den naechsten die wichtigste Information, die es gibt.
  await recordAttempt({
    ticketId,
    attempt: totalAttempt,
    agentName: implementer.name,
    outcome: !loopResult.finished
      ? "abgebrochen (Turn-/Zeitlimit erreicht), Arbeitsstand verworfen"
      : loopResult.files.length === 0
        ? `keine Dateiänderung. Begründung: ${loopResult.summary || "(keine)"}`
        : `geändert: ${loopResult.files.join(", ")}. ${loopResult.summary}`,
    trace: loopResult.trace,
  });

  // Der Umsetzungs-Loop eben kann (Budget 900s) minutenlang gedauert haben.
  // In der Zwischenzeit kann ein Klärungsbeschluss dieses Ticket längst
  // geschlossen haben (effect "close" in clarificationDecision.ts – bewusst
  // OHNE erneutes Einreihen, siehe Kommentar dort). Ohne diesen Re-Check
  // würde dieser jetzt veraltete Anlauf das DONE einfach überschreiben und
  // ein längst erledigtes Ticket wieder aufreißen, inklusive neuer Klärung –
  // beobachtet in OurJira: ein Ticket landete so bei 10 Klärungen, ohne dass
  // sich sein Status je bewegte.
  const freshStatus = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } });
  if (!freshStatus || freshStatus.status === "DONE") {
    helpers.logger.info(`Ticket ${ticket.title} wurde während der Bearbeitung bereits anderweitig geschlossen – Ergebnis verworfen.`);
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  const files = loopResult.files;
  const rejected = loopResult.rejected;
  const summary = loopResult.summary || "Ohne Zusammenfassung.";
  const notes = loopResult.notes;
  // Auch wenn ein Teil der Änderungen committet wird, muss der Rest, den QA
  // vielleicht vermisst, im Ergebnis stehen bleiben – sonst hat der nächste
  // Anlauf keine Ahnung, welche Datei am Ende doch nicht angefasst wurde.
  const rejectedSuffix = rejected.length > 0 ? `\n\n${formatRejectedFiles(rejected)}` : "";
  // Bereits im Loop geprüft (Mindestlänge, siehe worker/agentToolLoop.ts).
  const raisedQuestion = loopResult.clarification;
  // Die Wege, die der Umsetzer selbst sieht. Sie sind die einzigen fachlichen
  // Vorschlaege, die es sofort gibt – die ausgearbeitete Vorlage des Scrum
  // Masters kommt erst einen Modellaufruf spaeter.
  const raisedOptions = loopResult.clarificationOptions;

  if (rejected.length > 0) {
    await logActivity({
      projectId,
      ticketId,
      actor: implementer.name,
      agentId: implementer.id,
      action: "files_rejected",
      detail: `Nicht übernommen: ${rejected.map((file) => `${file.path} (${file.reason})`).join("; ")}`.slice(0, 1000),
    });
  }

  if (files.length === 0) {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: "IN_PROGRESS",
        result: `${summary}\n\n(Keine Dateiänderungen geliefert.)` +
          (rejected.length > 0 ? `\n\n${formatRejectedFiles(rejected)}` : ""),
      },
    });

    // Nichts uebernommen ist meistens ein handwerklicher Fehler (SEARCH passt
    // nicht, DATEI-Block fuer eine bestehende Datei) – keine Entscheidung, die
    // ein Mensch treffen muss. Solange der Agent nichts wirklich fragt, bekommt
    // er dieselbe Chance auf einen automatischen zweiten Anlauf wie nach einem
    // QA-Rework – mit der Erinnerung an die abgelehnten Pfade aus dem Ergebnis
    // oben. Erst wenn das auch scheitert, lohnt sich die Frage an den Menschen.
    if (!raisedQuestion && rejected.length > 0 && attempt < MAX_ATTEMPTS) {
      await logActivity({
        projectId,
        ticketId,
        actor: implementer.name,
        agentId: implementer.id,
        action: "ticket_reworked",
        detail: `„${ticket.title}": keine Änderung übernommen (${rejected.map((file) => file.path).join(", ")}) – automatischer zweiter Anlauf`,
      });
      await enqueueAgentJob("ticketWork", {
        agentId: implementer.id,
        projectId,
        ticketId,
        reason: `Erneuter Anlauf, keine Datei übernommen: ${rejected.map((file) => `${file.path} (${file.reason})`).join("; ")}`.slice(0, 300),
        attempt: attempt + 1,
      });
      if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
      return;
    }

    // Keine Datei geaendert und keine fachliche Rueckfrage: oft, weil das
    // Ticket gar keinen Code veraendern soll, sondern etwas Bestehendes nur
    // GEPRUEFT werden muss ("funktioniert der Export?"). Das kann kein
    // Modell aus einem leeren Diff heraus beantworten – also lassen wir es
    // tatsaechlich laufen, statt dem Auftraggeber die Frage "wurde getestet?"
    // vorzulegen (siehe attemptAutomaticVerification).
    if (!raisedQuestion && rejected.length === 0) {
      const verifier = (await agentForRole(projectId, "QA")) ?? implementer;
      const verification = await attemptAutomaticVerification({ dir, projectId, ticket, reviewer: verifier });
      if (verification) {
        await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: "IN_REVIEW",
            result: `${summary}\n\nAutomatische Prüfung (${verifier.name}): ${
              verification.allPassed ? "alle Prüf-Skripte erfolgreich." : "mindestens ein Prüf-Skript ist fehlgeschlagen."
            }`,
          },
        });
        await logActivity({
          projectId,
          ticketId,
          actor: verifier.name,
          agentId: verifier.id,
          action: "code_committed",
          detail: `${verification.commit.shortSha} · Automatische Prüfung dokumentiert (docs/technik/)`,
        });

        if (!verification.allPassed) {
          const failureDetail = formatCheckResults(verification.results).slice(0, 2000);
          if (attempt < MAX_ATTEMPTS) {
            await prisma.ticket.update({
              where: { id: ticketId },
              data: { plan: `${plan}\n\n## Automatische Prüfung ist fehlgeschlagen\n${failureDetail}` },
            });
            await enqueueAgentJob("ticketWork", {
              agentId: implementer.id,
              projectId,
              ticketId,
              reason: `Automatische Prüfung fehlgeschlagen – Nacharbeit noetig: ${failureDetail.slice(0, 200)}`,
              attempt: attempt + 1,
            });
          } else {
            await requestHumanReview(
              projectId,
              ticketId,
              ticket.title,
              `Automatische Prüfung schlägt nach ${attempt} Anläufen weiter fehl:\n${failureDetail}`,
              ticket.isCritical,
            );
          }
        } else if (ticket.isCritical) {
          await requestHumanReview(
            projectId,
            ticketId,
            ticket.title,
            "Kritisches Ticket – automatische Prüfung ist bestanden.",
            true,
          );
        } else {
          await prisma.ticket.update({ where: { id: ticketId }, data: { status: "DONE" } });
          await logActivity({
            projectId,
            ticketId,
            actor: verifier.name,
            agentId: verifier.id,
            action: "ticket_done",
            detail: `„${ticket.title}" ist fertig – automatische Prüfung bestanden`,
          });
        }

        if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
        return;
      }
    }

    // Frueher landete das trotzdem als Freigabe-Anfrage beim Menschen – eine
    // Freigabe fuer eine leere Aenderung. Jetzt ist es die Frage, die es
    // tatsaechlich ist: entweder hat der Agent selbst gefragt, oder auch der
    // automatische Anlauf hat keine brauchbare Aenderung zustande gebracht,
    // und es gibt im Repository nichts, was Scrumy automatisch haette
    // pruefen koennen.
    await logActivity({
      projectId,
      ticketId,
      actor: implementer.name,
      agentId: implementer.id,
      action: "ticket_without_changes",
      detail: `„${ticket.title}": keine Dateiänderungen geliefert – wartet auf einen Beschluss`,
    });
    await openClarification({
      projectId,
      scope: "TICKET",
      trigger: "no_changes",
      ticketId,
      sprintId: ticket.sprintId,
      raisedById: implementer.id,
      question: `„${ticket.title}": ${implementer.name} hat keine Änderung geliefert. Wie sollen wir mit dem Ticket umgehen?`,
      // Hat er dabei selbst eine Frage gestellt, sind seine Wege auch hier die
      // fachlich richtigen – sonst bleibt es bei den Standardvorschlägen.
      options: raisedOptions,
      context:
        (await repeatHistoryNote(ticketId)) +
        `Was ${implementer.name} dazu sagt:\n${summary}` +
        (notes ? `\n\nOffene Punkte: ${notes}` : "") +
        (raisedQuestion ? `\n\nRückfrage des Agenten: ${raisedQuestion}` : "") +
        (rejected.length > 0
          ? `\n\nNicht übernommene Dateien: ${rejected.map((file) => `${file.path} (${file.reason})`).join("; ")}`
          : ""),
      resume: { task: "ticketWork", payload: { ...payload, attempt: attempt + 1 } },
    });
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  // Dateien liegen bereits auf der Platte (jedes Werkzeug im Loop schreibt
  // sofort) – "git add -A" in commitAll erfasst sie unabhängig davon, wie
  // viele einzelne Werkzeugaufrufe dazu geführt haben.
  const written = files;
  const subject = (loopResult.commitMessage.split("\n")[0] || ticket.title).slice(0, 120);
  const commit = await commitAll(dir, {
    authorName: implementer.name,
    message:
      `${subject}\n\n${summary}${notes ? `\n\nOffen: ${notes}` : ""}\n\n` +
      `Ticket: ${ticket.title} (${ticket.id})\nSprint: ${ticket.sprint?.number ?? "-"}\nUmgesetzt von: ${implementer.name}`,
  });

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { status: "IN_REVIEW", result: `${summary}${rejectedSuffix}` },
  });

  await logActivity({
    projectId,
    ticketId,
    actor: implementer.name,
    agentId: implementer.id,
    action: "code_committed",
    detail: commit
      ? `${commit.shortSha} · ${subject} (${written.length} Dateien)`
      : `${subject} – inhaltlich keine Änderung im Repository`,
  });

  // Der Umsetzer hat selbst einberufen: Was er zweifelsfrei umsetzen konnte,
  // ist committet – ueber den Rest entscheidet der Auftraggeber. Ein QA-Review
  // waere hier vergebliche Modellzeit: Geprueft wird, wenn der Beschluss steht.
  if (raisedQuestion) {
    await logActivity({
      projectId,
      ticketId,
      actor: implementer.name,
      agentId: implementer.id,
      action: "clarification_raised",
      detail: `„${ticket.title}": ${raisedQuestion.slice(0, 300)}`,
    });
    await openClarification({
      projectId,
      scope: "TICKET",
      trigger: "agent_blocker",
      ticketId,
      sprintId: ticket.sprintId,
      raisedById: implementer.id,
      question: `„${ticket.title}": ${raisedQuestion}`,
      options: raisedOptions,
      context:
        (await repeatHistoryNote(ticketId)) +
        `${implementer.name} hat den unstrittigen Teil umgesetzt und committet (${commit?.shortSha ?? "kein Commit"}).\n\n` +
        `Zusammenfassung: ${summary}${notes ? `\n\nOffene Punkte: ${notes}` : ""}`,
      resume: { task: "ticketWork", payload: { ...payload, attempt: attempt + 1 } },
    });
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  // --- 3. Review durch QA ---------------------------------------------------
  const reviewer = (await agentForRole(projectId, "QA")) ?? implementer;
  const diff = commit ? (await gitShow(dir, commit.sha)).slice(0, 60_000) : "(kein Commit entstanden)";

  // Echte Prüfung statt Modell-Vermutung: QA bekommt hier kein "stell dir
  // vor, ob npm test wohl durchläuft", sondern das tatsächliche Ergebnis
  // eines soeben ausgeführten Laufs (siehe src/lib/testRun.ts). Scheitert der
  // Lauf technisch (kein Docker erreichbar), bleibt QA nicht blind stehen –
  // dann urteilt es wie bisher allein aus dem Diff.
  const checkTargets = await detectCheckTargets(dir);
  const checkResults = checkTargets.length > 0 ? await runChecks(projectId, checkTargets) : [];
  const checksRanForReal = checkResults.some((result) => !result.unavailable);
  const anyCheckFailed = checkResults.some((result) => checkFailed(result));

  const review = await runAgent({
    agent: reviewer,
    projectId,
    ticketId,
    sprintId: ticket.sprintId ?? undefined,
    kind: "review",
    headline: `Prüft Ticket „${ticket.title}"`,
    maxTokens: 4000,
    system: `${TEAM_GRUNDREGELN}

Du bist ${reviewer.name} (QA) und prüfst die Arbeit von ${implementer.name}. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `${ticketHead}

## Umsetzungsplan
${plan}

## Was ${implementer.name} dazu sagt
${summary}${notes ? `\n\nOffene Punkte: ${notes}` : ""}

## Änderung (Commit-Diff)
${diff}

## Automatisch ausgeführte Prüfung${checksRanForReal ? " (echter Lauf, kein Modellurteil)" : ""}
${checksRanForReal
  ? formatCheckResults(checkResults)
  : "(kein package.json mit test-/lint-/build-Skript gefunden, oder die automatische Prüfung war technisch nicht erreichbar – urteile allein aus dem Diff)"}

Prüfe: Erfüllt die Änderung das Ticket? Ist der Code in sich stimmig und passt er zum bestehenden Stand? Fehlt etwas Offensichtliches?

Antworte nur mit diesem JSON-Objekt:
{
  "verdict": "approve" | "rework" | "needs_decision",
  "comment": "Begründung in 2-5 Sätzen, konkret auf Dateien bezogen",
  "risk": "low" | "medium" | "high",
  "wege": [{ "label": "kurzer Titel", "detail": "was das konkret heißt, mit Für und Wider in 1-2 Sätzen" }]
}

"rework" nur bei echten Mängeln, nicht für Geschmacksfragen. Ein fehlgeschlagenes Prüf-Skript oben ist ein echter Mangel – "rework", nicht "needs_decision": ob Tests/Build/Lint durchlaufen, ist keine Entscheidung für den Auftraggeber, das ist eure Arbeit.
"needs_decision", wenn das Team die Frage gar nicht selbst beantworten kann – wenn Auftrag und Anforderungen sich widersprechen oder etwas Fachliches offen lassen. Schreibe dann in "comment" die Frage, die der Auftraggeber entscheiden muss. Nacharbeit hilft in dem Fall nicht: Ein zweiter Anlauf würde dieselbe Lücke nur anders raten. Fehlende oder nicht erreichbare Prüfung ist NIEMALS ein Grund für "needs_decision" – dann urteile aus dem Diff wie zuvor.
"wege" nur bei "needs_decision": zwei bis vier fachliche Möglichkeiten, zwischen denen der Auftraggeber wählt – nicht „nochmal versuchen" oder „abbrechen", die kennt Scrumy selbst. Sonst leer lassen.`,
  });

  // Derselbe Re-Check wie vor der Umsetzung: Auch der QA-Review-Aufruf kann
  // lange genug gedauert haben, dass ein Klärungsbeschluss das Ticket in der
  // Zwischenzeit schon geschlossen hat.
  const freshStatusAfterReview = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } });
  if (!freshStatusAfterReview || freshStatusAfterReview.status === "DONE") {
    helpers.logger.info(`Ticket ${ticket.title} wurde während des Reviews bereits anderweitig geschlossen – Urteil verworfen.`);
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  const parsedVerdict = readVerdict(review.text);
  // Verlass dich nicht darauf, dass das Modell die Anweisung oben befolgt:
  // ein wirklich fehlgeschlagenes Prüf-Skript ist ein harter Fakt, kein
  // Ermessen. Sagt QA trotzdem "approve" oder "needs_decision", stimmt das
  // schlicht nicht mit dem echten Lauf ueberein – dann gilt der echte Lauf.
  const { verdict, comment, risk, options: reviewOptions } =
    anyCheckFailed && parsedVerdict.verdict !== "rework"
      ? {
          ...parsedVerdict,
          verdict: "rework" as const,
          comment: `Automatische Prüfung ist fehlgeschlagen (siehe Ergebnis oben) – das sticht die Einschätzung von ${reviewer.name}: ${parsedVerdict.comment}`,
        }
      : parsedVerdict;

  await logActivity({
    projectId,
    ticketId,
    actor: reviewer.name,
    agentId: reviewer.id,
    action:
      verdict === "approve" ? "review_approved" : verdict === "rework" ? "review_rework" : "clarification_raised",
    detail: `„${ticket.title}": ${VERDICT_WORD[verdict]} (Risiko ${risk || "unbekannt"}) – ${comment.slice(0, 300)}`,
  });

  // QA sieht eine Frage, keine Mangelliste: Dann ist Nacharbeit die falsche
  // Antwort – ein zweiter Anlauf wuerde dieselbe Luecke nur anders raten.
  if (verdict === "needs_decision") {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { result: `${summary}\n\nQA (${reviewer.name}): ${comment}${rejectedSuffix}` },
    });
    await openClarification({
      projectId,
      scope: "TICKET",
      trigger: "qa_needs_decision",
      ticketId,
      sprintId: ticket.sprintId,
      raisedById: reviewer.id,
      question: `„${ticket.title}": ${comment}`,
      options: reviewOptions,
      context:
        `${reviewer.name} (QA) hat die Umsetzung von ${implementer.name} geprüft und kommt zu einer Frage, ` +
        `die das Team nicht selbst entscheiden kann.\n\nStand: ${commit?.shortSha ?? "kein Commit"} – ${summary}` +
        (notes ? `\n\nOffene Punkte: ${notes}` : ""),
      resume: { task: "ticketWork", payload: { ...payload, attempt: attempt + 1 } },
    });
    if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }

  if (verdict === "rework" && attempt < MAX_ATTEMPTS) {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: "IN_PROGRESS",
        result: `${summary}\n\nQA (${reviewer.name}): ${comment}${rejectedSuffix}`,
        plan: `${plan}\n\n## Nacharbeit nach QA-Review (${reviewer.name})\n${comment}`,
      },
    });
    await enqueueAgentJob("ticketWork", {
      agentId: implementer.id,
      projectId,
      ticketId,
      reason: `Nacharbeit nach QA-Review: ${comment.slice(0, 200)}`,
      attempt: attempt + 1,
    });
    return;
  }

  if (verdict === "rework") {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { result: `${summary}\n\nQA (${reviewer.name}): ${comment}${rejectedSuffix}` },
    });
    await requestHumanReview(
      projectId,
      ticketId,
      ticket.title,
      `QA sieht nach ${attempt} Anläufen weiter Mängel: ${comment}`,
      ticket.isCritical,
    );
  } else if (ticket.isCritical || risk === "high") {
    await requestHumanReview(
      projectId,
      ticketId,
      ticket.title,
      ticket.isCritical
        ? `Kritisches Ticket – QA hat freigegeben: ${comment}`
        : `QA stuft das Risiko als hoch ein: ${comment}`,
      ticket.isCritical,
    );
  } else {
    await prisma.ticket.update({ where: { id: ticketId }, data: { status: "DONE" } });
    await logActivity({
      projectId,
      ticketId,
      actor: reviewer.name,
      agentId: reviewer.id,
      action: "ticket_done",
      detail: `„${ticket.title}" ist fertig`,
    });
  }

  helpers.logger.info(`Ticket ${ticket.title} bearbeitet (${reason}).`);
  if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
};

type Verdict = "approve" | "rework" | "needs_decision";

const VERDICT_WORD: Record<Verdict, string> = {
  approve: "freigegeben",
  rework: "Nacharbeit nötig",
  needs_decision: "Frage an den Auftraggeber",
};

/// Liest das QA-Urteil. Faellt das JSON aus dem Rahmen, wird die Antwort im
/// Klartext ausgewertet statt den ganzen Ticket-Lauf scheitern zu lassen: Der
/// Code ist an dieser Stelle schon committet, und ein unlesbares Urteil ist
/// kein Grund, die Arbeit zu verwerfen. Im Zweifel gilt Nacharbeit – lieber
/// ein zweiter Blick als eine Freigabe, die niemand gegeben hat.
function readVerdict(text: string): {
  verdict: Verdict;
  comment: string;
  risk: string;
  options: ClarificationOption[];
} {
  try {
    const data = extractJsonObject(text);
    const raw = String(data.verdict ?? "").toLowerCase();
    const verdict: Verdict =
      raw.includes("needs") || raw.includes("decision") ? "needs_decision" : raw === "rework" ? "rework" : "approve";
    return {
      verdict,
      comment: String(data.comment ?? "").trim() || "(ohne Kommentar)",
      risk: String(data.risk ?? "").toLowerCase(),
      options: optionsFromAgent(data.wege),
    };
  } catch {
    const lower = text.toLowerCase();
    if (lower.includes("needs_decision")) {
      return { verdict: "needs_decision", comment: text.trim().slice(0, 2000), risk: "unbekannt", options: [] };
    }
    const approved = lower.includes("approve") && !lower.includes("rework");
    return {
      verdict: approved ? "approve" : "rework",
      comment: text.trim().slice(0, 2000) || "(unlesbare Antwort)",
      risk: "unbekannt",
      options: [],
    };
  }
}

/// Ticket bleibt in Review und wartet auf den Menschen. Die `ReviewApproval`
/// ist der Punkt, an dem das Team ausdruecklich abgibt – sichtbar auf dem Board
/// und im Protokoll.
///
/// Bevor sie im Büro landet, prüft der Product Owner die Freigabe (siehe
/// worker/tasks/reviewTriage.ts) – ausser bei als kritisch markierten Tickets:
/// Die hat der Product Owner selbst schon bei der Sprint-Planung so
/// eingestuft (`isCritical`, „erzwingt menschliches Review vor Deploy"), eine
/// erneute Pruefung durch dieselbe Rolle wuerde diesen Beschluss nur
/// unterlaufen.
async function requestHumanReview(
  projectId: string,
  ticketId: string,
  title: string,
  why: string,
  isCritical: boolean,
) {
  const existing = await prisma.reviewApproval.findFirst({ where: { ticketId, decision: "PENDING" } });
  const review =
    existing ??
    (await prisma.reviewApproval.create({
      data: { ticketId, reviewerName: "Mensch", comment: why.slice(0, 2000) },
    }));
  await prisma.ticket.update({ where: { id: ticketId }, data: { status: "IN_REVIEW" } });
  await logActivity({
    projectId,
    ticketId,
    actor: "Scrumy",
    action: "human_review_requested",
    detail: `„${title}" wartet auf eine menschliche Freigabe: ${why.slice(0, 300)}`,
  });

  if (!existing && !isCritical) {
    const productOwner = await agentForRole(projectId, "PRODUCT_OWNER");
    if (productOwner) {
      await enqueueAgentJob("reviewTriage", {
        agentId: productOwner.id,
        projectId,
        reviewId: review.id,
        reason: "Freigabe vor Vorlage geprüft",
      });
    }
  }
}

export default ticketWork;
