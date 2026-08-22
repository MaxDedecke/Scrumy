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
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { extractJsonObject } from "@/lib/llm";
import { commitAll, gitShow, readRelevantSourceContext, readRepoFile, repoOverview, writeFiles } from "@/lib/workspace";
import { agentForRole, roleForTicket } from "@/lib/team";
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { optionsFromAgent, type ClarificationOption } from "@/lib/clarificationOptions";
import { checkFailed, detectCheckTargets, formatCheckResults, runChecks, type CheckRunResult } from "@/lib/testRun";
import {
  findInternalHostnameLeaks,
  formatInternalHostnameLeaks,
  runAgentIntegrationCheck,
  type AgentIntegrationCheckResult,
} from "@/lib/liveStack";
import type { Agent } from "@/generated/prisma/client";
import { AgentRunError, logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject } from "../orchestration";
import { openClarification } from "../clarification";
import { enqueueAgentJob } from "../queue";
import { runImplementationLoop, type AttemptTrace } from "../agentToolLoop";
import { integrateAndFinalizeTicket } from "../ticketWorktree";
import type { TicketWorkPayload } from "../taskTypes";
import { withWorkspaceLock } from "../workspaceLock";

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
    lines.push(
      `(${trace.turns} Arbeitsschritte` +
        (trace.replayed > 0 ? `, davon ${trace.replayed} bereits vorher gemachte Abfragen wiederholt` : "") +
        ")",
    );
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
    // Wie bei sprint_planning (dieselbe Begründung: OpenRouter routet dieses
    // Profil ueber viele Anbieter mit stark schwankendem Durchsatz) auf den
    // schnelleren Anbieter sortieren lassen, statt es dem Zufall zu ueberlassen.
    preferThroughput: true,
    // Wie bei sprint_refinement (worker/tasks/sprintPlanning.ts, dieselbe
    // Begründung dort): Mehrere in sich stimmige Teiltickets aus einem zu
    // großen Arbeitsschritt herauszuarbeiten braucht dem Modell erkennbar
    // mehr Überlegung als eine einzelne Antwort – der DEFAULT_TIMEOUT_MS
    // (5 Min., siehe worker/agentRun.ts) reichte dafür beobachtet nicht immer.
    timeoutMs: 480_000,
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
  workspaceSubpath,
  ticket,
  reviewer,
}: {
  dir: string;
  workspaceSubpath: string;
  ticket: { id: string; title: string };
  reviewer: Agent;
}): Promise<AutomaticVerification | null> {
  const targets = await detectCheckTargets(dir);
  if (targets.length === 0) return null;

  const results = await runChecks(workspaceSubpath, targets);
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
    preferThroughput: true,
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

/// Das Urteil ueber die Behauptung "es gibt hier nichts zu tun".
interface NoChangeAudit {
  /// "erfuellt": jedes Akzeptanzkriterium ist am Code nachweisbar erfuellt.
  /// "luecke": mindestens eines nachweislich nicht – dann ist das ein
  /// Arbeitsauftrag, keine Frage. "unklar": am Code nicht entscheidbar.
  verdict: "erfuellt" | "luecke" | "unklar";
  reason: string;
  gaps: string[];
  question: string;
}

/// Prueft nach, wenn der Umsetzer ohne eine einzige Aenderung zurueckkommt.
///
/// Das war der haeufigste Ausgang ueberhaupt (28 von 43 beobachteten
/// Anlaeufen) und landete jedes Mal als Klaerung beim Auftraggeber: „X hat
/// keine Änderung geliefert. Wie sollen wir mit dem Ticket umgehen?" – 15 von
/// 18 Klaerungen waren dieser eine Satz. Das ist keine Entscheidung, die ein
/// Mensch treffen kann: Der Umsetzer behauptet, alles sei schon da, und ob das
/// stimmt, steht im Repository. Also nachsehen statt fragen – und je nach
/// Befund abschliessen, gezielt nacharbeiten lassen oder (nur dann) fragen.
async function auditNoChangeClaim({
  agent,
  projectId,
  ticket,
  dir,
  claim,
}: {
  agent: Agent;
  projectId: string;
  ticket: { id: string; title: string; description: string | null; sprintId: string | null };
  dir: string;
  /// Womit der Umsetzer begruendet hat, dass nichts zu tun war.
  claim: string;
}): Promise<NoChangeAudit | null> {
  const focus = `${ticket.title}\n${ticket.description ?? ""}`;
  const sourceContext = await readRelevantSourceContext(dir, focus, { maxChars: 12_000, maxFiles: 8 });

  const audited = await runAgent({
    agent,
    projectId,
    ticketId: ticket.id,
    sprintId: ticket.sprintId ?? undefined,
    kind: "no_change_audit",
    headline: `Prüft nach: „${ticket.title}" ohne Änderung zurückgegeben`,
    maxTokens: 900,
    preferThroughput: true,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name} und prüfst eine Behauptung nach: Ein Kollege gibt ein Ticket zurück, ohne eine Zeile geändert zu haben, weil angeblich schon alles da ist. Du gehst die Akzeptanzkriterien einzeln durch und urteilst allein am vorliegenden Code. Du änderst nichts. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `## Ticket
${ticket.title}
${clipForPrompt(ticket.description ?? "", 4000)}

## Was der Umsetzer sagt
${clipForPrompt(claim || "(keine Begründung abgegeben)", 2000)}

## Bestehender Code (zum Ticket passende Auswahl)
${sourceContext}

Geh die Akzeptanzkriterien des Tickets einzeln durch und prüfe jedes am Code.

- "erfuellt": Du kannst JEDES Kriterium konkret am gezeigten Code belegen (Datei, Funktion, Endpunkt). Nur dann.
- "luecke": Mindestens ein Kriterium ist nachweislich nicht erfüllt. Schreibe in "gaps" je einen kurzen, umsetzbaren Satz pro fehlendem Punkt – das ist die Arbeitsanweisung für den nächsten Anlauf, also konkret: welche Datei, welches Verhalten.
- "unklar": Das Ticket lässt sich am Code gar nicht beurteilen, weil eine fachliche Entscheidung fehlt oder Auftrag und Anforderungen sich widersprechen. Schreibe dann in "question" die eine Frage, die der Auftraggeber beantworten muss. Fehlende Prüfmöglichkeit ist KEIN Grund für "unklar" – urteile dann aus dem Code.

Antworte nur so:
{"verdict": "erfuellt"|"luecke"|"unklar", "reason": "ein bis zwei Sätze Begründung", "gaps": ["..."], "question": "..."}`,
  });

  const parsed = extractJsonObject(audited.text);
  const verdict = String(parsed.verdict ?? "");
  if (verdict !== "erfuellt" && verdict !== "luecke" && verdict !== "unklar") return null;
  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.map((gap) => String(gap).trim()).filter(Boolean).slice(0, 8)
    : [];
  // Eine "luecke" ohne benannte Luecke ist keine Arbeitsanweisung, sondern nur
  // ein Gefuehl – dann lieber fragen als blind noch einen Anlauf verbrennen.
  if (verdict === "luecke" && gaps.length === 0) return null;
  return {
    verdict,
    reason: String(parsed.reason ?? "").trim().slice(0, 600),
    gaps,
    question: String(parsed.question ?? "").trim().slice(0, 400),
  };
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
  // Ticket-Load VOR dem Sperren, um zu wissen, welches Verzeichnis ueberhaupt
  // gesperrt werden muss: Ein vom Scrum Master als parallele Zusatzarbeit
  // gestartetes Ticket (siehe worker/tasks/parallelCheck.ts) hat ein eigenes
  // Git-Worktree (`ticket.worktreePath`) und laeuft dort komplett unabhaengig
  // vom Hauptverzeichnis – der Normalfall bleibt unveraendert direkt im
  // Hauptverzeichnis.
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { sprint: true } });
  if (!ticket || ticket.status === "DONE") {
    if (ticket?.sprintId) await continueSprint(projectId, ticket.sprintId);
    return;
  }
  const dir = ticket.worktreePath ?? project.workspacePath;
  const workspaceSubpath = ticket.worktreePath ? path.basename(ticket.worktreePath) : projectId;

  // Ab hier wird gelesen und geschrieben (Planung, Umsetzungs-Loop,
  // automatische Prüfung, Commit) – bei einem Ticket ohne eigenes Worktree
  // im selben Hauptverzeichnis wie ein zweites Ticket desselben Projekts, das
  // gerade parallel bei einem anderen Kollegen in dessen eigenem Worktree
  // läuft (Jobs sind nur pro Agent serialisiert, nicht pro Projekt, siehe
  // worker/queue.ts) – `withWorkspaceLock` ist pro VERZEICHNIS geschlüsselt,
  // ein Worktree hat also nie Streit mit dem Hauptverzeichnis. Ohne diese
  // Sperre könnte ein fehlgeschlagener Anlauf (discardUncommittedChanges) den
  // unfertigen, aber legitimen Stand eines anderen, im selben Verzeichnis
  // arbeitenden Agenten wegreißen. Bewusst NICHT neu eingerückt, um den Diff
  // auf die eigentliche Änderung zu beschränken.
  return withWorkspaceLock(dir, async () => {

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
      const finalized = await integrateAndFinalizeTicket({
        ticketId,
        projectId,
        extraData: { result: `Bereits erfüllt (automatisch geprüft, kein neuer Anlauf nötig): ${already.reason}` },
      });
      if (!finalized.ok) {
        await enqueueAgentJob("ticketWork", {
          agentId: implementer.id,
          projectId,
          ticketId,
          reason: `Zusammenführen mit dem Hauptbranch fehlgeschlagen: ${finalized.error.slice(0, 200)}`,
          attempt: attempt + 1,
        });
        return;
      }
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

  // Nudge nur fuer BUG-Tickets: Ein Fehler, der beim Testen der Live-
  // Anwendung/Vorschau auftrat (siehe src/lib/actions/bugReport.ts), laesst
  // sich per `run_command` allein oft nicht nachstellen – die dortige Sandbox
  // kennt kein Compose-Netz und keine DB. Ohne diesen Hinweis endete das
  // real in "scheint ein Docker-Problem zu sein", ohne dass das je geprueft
  // wurde.
  const bugRepro =
    ticket.type === "BUG"
      ? '\n\nFalls der Fehler nur im laufenden System auftritt (z.B. aus einer Bug-Meldung zur Vorschau/Live-Anwendung): Vermute nicht bloß eine Ursache – nutze `run_integration_check` (HTTP-Request/Datei-Upload) bzw. `check_in_browser` (alles, was der Nutzer im Browser sieht), um den echten Docker-Compose-Stack zu starten und den Fehler selbst nachzustellen, bevor du einen Fix schreibst oder das Ticket als „vermutlich Docker-Problem" abschließt.'
      : "";

  // Nudge fuer alles, was ein Mensch am Ende im Browser sieht: Ein Frontend
  // kann serverseitig einwandfrei ausgeliefert werden und im Browser trotzdem
  // komplett kaputt sein (JavaScript-Fehler, fetch auf einen internen
  // Compose-Servicenamen). Ohne diesen Hinweis schliesst der Agent das Ticket
  // nach einem gruenen Unit-Test ab, ohne die Ansicht je gesehen zu haben.
  const browserCheck =
    implementer.role === "FRONTEND" || implementer.role === "DESIGN"
      ? '\n\nBevor du dieses Ticket abschließt: Sieh dir die betroffene Ansicht mit `check_in_browser` in einem echten Browser an. Ein grüner Unit-Test sagt nichts darüber, ob die Seite im Browser überhaupt aufgeht, ob sie Inhalt zeigt und ob ihre Requests durchkommen. Achte im Ergebnis besonders auf unbehandelte JavaScript-Fehler und fehlgeschlagene Requests.'
      : "";

  const ticketHead =
    `## Ticket\n${ticket.title}\nTyp: ${TICKET_TYPE_LABEL[ticket.type]} · Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
    `${ticket.isCritical ? " · kritisch (braucht menschliche Freigabe)" : ""}\n\n${clipForPrompt(ticket.description ?? "", 6000)}${bugRepro}${browserCheck}`;

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
      preferThroughput: true,
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
      workspaceSubpath,
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
    const message = error instanceof Error ? error.message : String(error);

    // Von Hand abgebrochen (Stopp-Knopf im Nachweis, siehe
    // worker/agentRun.ts#failRun): kein fachlicher oder technischer
    // Fehlschlag, also auch keine Freigabe-Anfrage wie im Absturz-Zweig unten
    // – `failRun` hat die Klärung, die den Product Owner zur Entscheidung
    // ruft ("nochmal versuchen"?), schon eröffnet. Hier nur noch der
    // Anlauf-Nachweis.
    if (error instanceof AgentRunError && error.code === "CANCELLED") {
      helpers.logger.info(`Ticket ${ticket.title}: Anlauf von Hand abgebrochen.`);
      await recordAttempt({
        ticketId,
        attempt: totalAttempt,
        agentName: implementer.name,
        outcome: "von Hand abgebrochen",
        trace: (error as { attemptTrace?: AttemptTrace }).attemptTrace,
      });
      return;
    }

    // Anbieter/Netzwerk-Fehler (siehe LlmError-Code "TRANSPORT" in
    // src/lib/llm.ts – u.a. 429/502/503/504/524, `postJson` versucht es davor
    // schon zweimal selbst erneut) sind kein Programmfehler und keine
    // fachliche Sackgasse im Ticket, sondern ein Ausrutscher der Infrastruktur
    // (beobachtet im Drapbox-Projekt: RunPod/Cloudflare-524 nach 125s). Den
    // trotzdem sofort dem Menschen vorzulegen (wie im Absturz-Zweig unten)
    // nimmt ein Ticket aus der automatischen Bearbeitung, obwohl vom
    // Anlauf-Budget meist noch reichlich übrig ist. Stattdessen nur den
    // Anlauf verbuchen und normal weitermachen – reicht das Budget nicht
    // mehr, eröffnet `reportStalledTickets` (siehe continueSprint) ohnehin
    // die passende Klärung.
    if (error instanceof AgentRunError && error.code === "TRANSPORT") {
      helpers.logger.warn(`Ticket ${ticket.title}: Anbieter/Netzwerk-Fehler – ${message}`);
      await recordAttempt({
        ticketId,
        attempt: totalAttempt,
        agentName: implementer.name,
        outcome: `Anbieter/Netzwerk-Fehler, wird automatisch erneut versucht: ${message.slice(0, 200)}`,
        trace: (error as { attemptTrace?: AttemptTrace }).attemptTrace,
      });
      await logActivity({
        projectId,
        ticketId,
        actor: "Scrumy",
        action: "step_failed",
        detail: `„${ticket.title}" – Anbieter/Netzwerk-Fehler (Anlauf ${attempt}), wird automatisch erneut versucht: ${message.slice(0, 300)}`,
      });
      if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
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

  // Der Umsetzungs-Loop eben kann (Budget 2100s) minutenlang gedauert haben.
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
      const verification = await attemptAutomaticVerification({ dir, workspaceSubpath, ticket, reviewer: verifier });
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
          const finalized = await integrateAndFinalizeTicket({ ticketId, projectId });
          if (!finalized.ok) {
            await enqueueAgentJob("ticketWork", {
              agentId: implementer.id,
              projectId,
              ticketId,
              reason: `Zusammenführen mit dem Hauptbranch fehlgeschlagen: ${finalized.error.slice(0, 200)}`,
              attempt: attempt + 1,
            });
            return;
          }
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

    // Der Umsetzer behauptet, es sei nichts zu tun. Ob das stimmt, steht im
    // Repository – also nachsehen, statt dem Auftraggeber eine Frage
    // vorzulegen, die er gar nicht beantworten kann (siehe
    // auditNoChangeClaim). Nur wenn auch die Nachpruefung nicht weiterkommt,
    // wird daraus eine Klaerung.
    let audit: NoChangeAudit | null = null;
    if (!raisedQuestion) {
      const auditor = (await agentForRole(projectId, "QA")) ?? implementer;
      audit = await auditNoChangeClaim({
        agent: auditor,
        projectId,
        ticket,
        dir,
        claim: `${summary}${notes ? `\n\nOffene Punkte: ${notes}` : ""}`,
      });

      if (audit?.verdict === "erfuellt") {
        const result = `Ohne Änderung abgeschlossen: ${audit.reason}`;
        if (ticket.isCritical) {
          await requestHumanReview(projectId, ticketId, ticket.title, `Kritisches Ticket, keine Änderung nötig – ${audit.reason}`, true);
        } else {
          const finalized = await integrateAndFinalizeTicket({ ticketId, projectId, extraData: { result } });
          if (!finalized.ok) {
            await enqueueAgentJob("ticketWork", {
              agentId: implementer.id,
              projectId,
              ticketId,
              reason: `Zusammenführen mit dem Hauptbranch fehlgeschlagen: ${finalized.error.slice(0, 200)}`,
              attempt: attempt + 1,
            });
            return;
          }
          await logActivity({
            projectId,
            ticketId,
            actor: auditor.name,
            agentId: auditor.id,
            action: "ticket_done",
            detail: `„${ticket.title}" ist erfüllt, ohne dass etwas zu ändern war – von ${auditor.name} am Code nachgeprüft (${audit.reason.slice(0, 200)})`,
          });
        }
        if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
        return;
      }

      // Eine benannte Luecke ist ein Arbeitsauftrag, keine Frage: Der naechste
      // Anlauf bekommt sie in den Plan geschrieben und laeuft sofort weiter.
      // Begrenzt wird das nicht von MAX_ATTEMPTS (das gilt fuer blinde
      // Wiederholungen), sondern vom Anlauf-Budget des Tickets – jede Runde
      // hier traegt eine neue, konkrete Anweisung.
      if (audit?.verdict === "luecke" && totalAttempt < ticket.attemptBudget) {
        const gapList = audit.gaps.map((gap) => `- ${gap}`).join("\n");
        await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            plan: `${plan}\n\n## Nachgeprüft nach Anlauf ${totalAttempt} (${auditor.name}): diese Punkte fehlen noch\n${gapList}`,
          },
        });
        await logActivity({
          projectId,
          ticketId,
          actor: auditor.name,
          agentId: auditor.id,
          action: "ticket_reworked",
          detail: `„${ticket.title}": keine Änderung geliefert, aber ${audit.gaps.length} offene(r) Punkt(e) am Code nachgewiesen – Nacharbeit statt Rückfrage`,
        });
        await enqueueAgentJob("ticketWork", {
          agentId: implementer.id,
          projectId,
          ticketId,
          reason: `Nachprüfung nach Anlauf ${totalAttempt}: ${audit.gaps.join("; ")}`.slice(0, 300),
          attempt: attempt + 1,
        });
        if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
        return;
      }
    }

    // Jetzt erst der Mensch: Entweder hat der Agent selbst eine fachliche
    // Frage gestellt, die Nachpruefung kommt am Code nicht weiter, oder das
    // Anlauf-Budget ist aufgebraucht. Anders als frueher geht die Frage nicht
    // mehr als „keine Änderung geliefert, was nun?" raus, sondern mit dem
    // konkreten Befund.
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
      // Eine echte Frage schlaegt die Verlegenheitsfrage: Hat die Nachpruefung
      // benannt, woran es haengt, steht das hier – nicht mehr „keine Änderung
      // geliefert, was nun?", worauf niemand sinnvoll antworten kann.
      question: audit?.question
        ? `„${ticket.title}": ${audit.question}`
        : `„${ticket.title}": ${implementer.name} hat keine Änderung geliefert. Wie sollen wir mit dem Ticket umgehen?`,
      // Hat er dabei selbst eine Frage gestellt, sind seine Wege auch hier die
      // fachlich richtigen – sonst bleibt es bei den Standardvorschlägen.
      options: raisedOptions,
      context:
        (await repeatHistoryNote(ticketId)) +
        `Was ${implementer.name} dazu sagt:\n${summary}` +
        (notes ? `\n\nOffene Punkte: ${notes}` : "") +
        (raisedQuestion ? `\n\nRückfrage des Agenten: ${raisedQuestion}` : "") +
        (audit
          ? `\n\nNachprüfung am Code: ${audit.reason}` +
            (audit.gaps.length > 0 ? `\nOffen geblieben:\n${audit.gaps.map((gap) => `- ${gap}`).join("\n")}` : "")
          : "") +
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
  const checkResults = checkTargets.length > 0 ? await runChecks(workspaceSubpath, checkTargets) : [];
  const checksRanForReal = checkResults.some((result) => !result.unavailable);
  const anyCheckFailed = checkResults.some((result) => checkFailed(result));

  // Zusaetzlich zu den Skript-Checks oben (isolierte Sandbox, kein Compose-
  // Netz/DB, siehe testRun.ts): Bei BUG-/INTEGRATION-Tickets, oder wenn diese
  // Aenderung mehrere Dienste zugleich beruehrt (z.B. Frontend UND Backend),
  // faehrt QA den echten Docker-Compose-Stack hoch, statt sich allein auf
  // "Tests liefen durch" zu verlassen – genau die Luecke, die dazu fuehrte,
  // dass ein Upload-Bug (nur im Zusammenspiel mehrerer Dienste sichtbar)
  // unverifiziert als "vermutlich Docker-Problem" liegen blieb, siehe
  // [[scrumy-projekt]]. Bewusst NICHT bei jedem Ticket (Stack-Neubau dauert
  // Minuten) – FEATURE-/CHORE-Tickets innerhalb eines Diensts bleiben bei der
  // guenstigeren Sandbox-Pruefung, die volle Integrationsprüfung deckt sie am
  // Sprintende ohnehin ab (runSprintIntegrationCheck).
  const serviceTargets = checkTargets.filter((target) => target.relDir !== ".");
  const touchedServices = new Set(
    serviceTargets
      .filter((target) => written.some((file) => file === target.relDir || file.startsWith(`${target.relDir}/`)))
      .map((target) => target.relDir),
  );
  const needsIntegrationCheck = commit !== null && (ticket.type === "BUG" || ticket.type === "INTEGRATION" || touchedServices.size >= 2);
  const integrationResult: AgentIntegrationCheckResult | null = needsIntegrationCheck
    ? await runAgentIntegrationCheck(projectId, null)
    : null;
  // Wie bei checkFailed(): "unavailable" (anderes Projekt live, kein Compose-
  // File) ist ein Infrastrukturgrund, kein Mangel an der Aenderung – nur ein
  // ECHTER Fehlschlag beim Hochfahren zaehlt als Befund.
  const integrationFailed = integrationResult !== null && !integrationResult.reachable && !integrationResult.unavailable;

  // Deterministischer Textmuster-Scan statt Docker-Neubau, deshalb bei JEDEM
  // Ticket mit Commit – nicht nur BUG/INTEGRATION/Cross-Service (siehe
  // findInternalHostnameLeaks): genau diese Prüfung haette den echten
  // Upload-Vorfall schon beim Entstehen gefunden, nicht erst beim
  // Ausprobieren im Browser.
  const hostnameLeaks = commit !== null ? await findInternalHostnameLeaks(dir) : [];
  const integrationReport = !integrationResult
    ? null
    : integrationResult.unavailable
      ? `Übersprungen: ${integrationResult.blockedReason}`
      : integrationResult.reachable
        ? `Bestanden – voller Stack (Frontend+Backend+DB) kam sauber hoch (Port ${integrationResult.port}).`
        : `NICHT bestanden – voller Stack kam nicht sauber hoch: ${integrationResult.blockedReason}\n\nLog:\n${integrationResult.logs}`;

  if (integrationResult && !integrationResult.unavailable) {
    await logActivity({
      projectId,
      ticketId,
      actor: reviewer.name,
      agentId: reviewer.id,
      action: "integration_check",
      detail: `„${ticket.title}": ${integrationReport}`,
    });
  }

  if (hostnameLeaks.length > 0) {
    await logActivity({
      projectId,
      ticketId,
      actor: reviewer.name,
      agentId: reviewer.id,
      action: "hostname_leak_found",
      detail: `„${ticket.title}": interner Compose-Servicename im Browser-Code – ${formatInternalHostnameLeaks(hostnameLeaks)}`,
    });
  }

  const review = await runAgent({
    agent: reviewer,
    projectId,
    ticketId,
    sprintId: ticket.sprintId ?? undefined,
    kind: "review",
    headline: `Prüft Ticket „${ticket.title}"`,
    maxTokens: 4000,
    preferThroughput: true,
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
${integrationReport ? `\n## Integrationsprüfung (echter Docker-Compose-Stack, Frontend+Backend+DB)\n${integrationReport}\n` : ""}${
      hostnameLeaks.length > 0
        ? `\n## Interner Compose-Servicename im Browser-Code gefunden\nDer Code eines veröffentlichten (im Browser geöffneten) Diensts verweist auf den Servicenamen eines NICHT veröffentlichten Diensts – so eine Adresse existiert nur im internen Docker-Netz, der Browser des Nutzers kann sie nicht auflösen:\n${formatInternalHostnameLeaks(hostnameLeaks)}\n`
        : ""
    }
Prüfe: Erfüllt die Änderung das Ticket? Ist der Code in sich stimmig und passt er zum bestehenden Stand? Fehlt etwas Offensichtliches?

Antworte nur mit diesem JSON-Objekt:
{
  "verdict": "approve" | "rework" | "needs_decision",
  "comment": "Begründung in 2-5 Sätzen, konkret auf Dateien bezogen",
  "risk": "low" | "medium" | "high",
  "wege": [{ "label": "kurzer Titel", "detail": "was das konkret heißt, mit Für und Wider in 1-2 Sätzen" }]
}

"rework" nur bei echten Mängeln, nicht für Geschmacksfragen. Ein fehlgeschlagenes Prüf-Skript oder eine NICHT bestandene Integrationsprüfung oben ist ein echter Mangel – "rework", nicht "needs_decision": ob Tests/Build/Lint/der volle Stack durchlaufen, ist keine Entscheidung für den Auftraggeber, das ist eure Arbeit.
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
      : integrationFailed && parsedVerdict.verdict !== "rework"
        ? {
            ...parsedVerdict,
            verdict: "rework" as const,
            comment: `Integrationsprüfung (voller Docker-Compose-Stack) ist fehlgeschlagen: ${integrationResult?.blockedReason} – das sticht die Einschätzung von ${reviewer.name}: ${parsedVerdict.comment}`,
          }
        : hostnameLeaks.length > 0 && parsedVerdict.verdict !== "rework"
          ? {
              ...parsedVerdict,
              verdict: "rework" as const,
              comment: `Interner Compose-Servicename im Browser-Code gefunden (siehe Ergebnis oben) – im Browser des Nutzers nicht auflösbar. Das sticht die Einschätzung von ${reviewer.name}: ${parsedVerdict.comment}`,
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

  // Nach QA-Freigabe entscheidet bei kritischen/riskanten Tickets weiter der
  // Mensch, sonst gilt das Ticket als fertig – gebündelt in einer Funktion,
  // weil ab hier zwei Wege dorthin führen (direkt nach QA, oder erst nach
  // einem zusätzlichen Design-Review).
  // Gibt `false` zurueck, wenn das Ticket in einem eigenen Worktree lief und
  // sich nicht in den Hauptbranch uebernehmen liess – der Aufrufer schickt es
  // dann wie jeden anderen technisch gescheiterten Anlauf zur Nacharbeit,
  // statt es als fertig zu vermelden.
  const finalizeQaApproved = async (): Promise<boolean> => {
    if (ticket.isCritical || risk === "high") {
      await requestHumanReview(
        projectId,
        ticketId,
        ticket.title,
        ticket.isCritical
          ? `Kritisches Ticket – QA hat freigegeben: ${comment}`
          : `QA stuft das Risiko als hoch ein: ${comment}`,
        ticket.isCritical,
      );
      return true;
    }
    const finalized = await integrateAndFinalizeTicket({ ticketId, projectId });
    if (!finalized.ok) {
      await enqueueAgentJob("ticketWork", {
        agentId: implementer.id,
        projectId,
        ticketId,
        reason: `Zusammenführen mit dem Hauptbranch fehlgeschlagen: ${finalized.error.slice(0, 200)}`,
        attempt: attempt + 1,
      });
      return false;
    }
    await logActivity({
      projectId,
      ticketId,
      actor: reviewer.name,
      agentId: reviewer.id,
      action: "ticket_done",
      detail: `„${ticket.title}" ist fertig`,
    });
    return true;
  };

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
  } else {
    // QA hat freigegeben. Bei Frontend-Tickets prüft zusätzlich Design gegen
    // docs/design-konzept.md, bevor das Ticket als fertig gilt – erst danach
    // greift dieselbe Kritisch/Risiko-Abwägung wie bisher.
    const designVerdict =
      implementer.role === "FRONTEND"
        ? await runDesignReview({ projectId, dir, ticketId, ticketTitle: ticket.title, ticketHead, implementer, diff })
        : null;

    if (designVerdict?.verdict === "rework" && attempt < MAX_ATTEMPTS) {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: "IN_PROGRESS",
          result: `${summary}\n\nDesign (${designVerdict.reviewerName}): ${designVerdict.comment}`,
          plan: `${plan}\n\n## Nacharbeit nach Design-Review (${designVerdict.reviewerName})\n${designVerdict.comment}`,
        },
      });
      await enqueueAgentJob("ticketWork", {
        agentId: implementer.id,
        projectId,
        ticketId,
        reason: `Nacharbeit nach Design-Review: ${designVerdict.comment.slice(0, 200)}`,
        attempt: attempt + 1,
      });
      return;
    }

    if (designVerdict?.verdict === "rework") {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { result: `${summary}\n\nDesign (${designVerdict.reviewerName}): ${designVerdict.comment}` },
      });
      await requestHumanReview(
        projectId,
        ticketId,
        ticket.title,
        `Design sieht nach ${attempt} Anläufen weiter Mängel: ${designVerdict.comment}`,
        ticket.isCritical,
      );
    } else if (!(await finalizeQaApproved())) {
      return;
    }
  }

  helpers.logger.info(`Ticket ${ticket.title} bearbeitet (${reason}).`);
  if (ticket.sprintId) await continueSprint(projectId, ticket.sprintId);
  });
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

/// Liest das Verdikt des Design-Reviews. Anders als `readVerdict` kennt es nur
/// approve/rework (keine "needs_decision") – die Design-Rolle prüft gegen ein
/// festgelegtes Konzept, das lässt sich nicht an den Auftraggeber weiterreichen.
/// Unlesbare Antworten gelten als Nacharbeit, aus demselben Grund wie bei QA:
/// der Code ist schon committet, ein zweiter Blick kostet weniger als eine
/// Freigabe, die niemand ausgesprochen hat.
function readDesignVerdict(text: string): { verdict: "approve" | "rework"; comment: string } {
  try {
    const data = extractJsonObject(text);
    const verdict = String(data.verdict ?? "").toLowerCase() === "approve" ? "approve" : "rework";
    return { verdict, comment: String(data.comment ?? "").trim() || "(ohne Kommentar)" };
  } catch {
    const lower = text.toLowerCase();
    const approved = lower.includes("approve") && !lower.includes("rework");
    return { verdict: approved ? "approve" : "rework", comment: text.trim().slice(0, 2000) || "(unlesbare Antwort)" };
  }
}

/// Zweite Prüfung nach QA, nur für Frontend-Tickets: Erfüllt die Umsetzung
/// auch das Design-Konzept (`docs/design-konzept.md`, siehe teamKickoff.ts)?
/// QA urteilt funktional, nicht über Farben/Abstände/Zustände – ohne diesen
/// zweiten Blick sah ein "fertiges" Ticket am Ende trotzdem nach Rohentwurf
/// aus. Gibt `null` zurück, wenn es keinen eigenen Design-Agenten gibt oder
/// (noch) kein Design-Konzept im Repo liegt – dann bleibt es beim QA-Urteil,
/// wie vor Einführung dieser Rolle.
async function runDesignReview(input: {
  projectId: string;
  dir: string;
  ticketId: string;
  ticketTitle: string;
  ticketHead: string;
  implementer: Agent;
  diff: string;
}): Promise<{ verdict: "approve" | "rework"; comment: string; reviewerName: string } | null> {
  const designer = await agentForRole(input.projectId, "DESIGN");
  if (!designer || designer.role !== "DESIGN") return null;

  const concept = await readRepoFile(input.dir, "docs/design-konzept.md");
  if (!concept) return null;

  const { text } = await runAgent({
    agent: designer,
    projectId: input.projectId,
    ticketId: input.ticketId,
    kind: "design_review",
    headline: `Prüft „${input.ticketTitle}" gegen das Design-Konzept`,
    maxTokens: 3000,
    preferThroughput: true,
    system: `${TEAM_GRUNDREGELN}

Du bist ${designer.name} und verantwortest das Design-Konzept dieses Projekts. Du prüfst eine Frontend-Änderung von ${input.implementer.name} dagegen. Du antwortest ausschließlich mit einem JSON-Objekt.`,
    prompt: `${input.ticketHead}

## Design-Konzept des Projekts
${clipForPrompt(concept, 8000)}

## Änderung (Commit-Diff)
${input.diff}

Prüfe NUR die Design-/UX-Seite, nicht die fachliche Logik (das hat QA schon getan): Passt die Umsetzung zu Farb-/Typo-/Spacing-Skala, den festgelegten Komponenten, den Zuständen (leer/lädt/Fehler) und dem responsiven Verhalten aus dem Design-Konzept?

Antworte nur mit diesem JSON-Objekt:
{
  "verdict": "approve" | "rework",
  "comment": "Begründung in 2-4 Sätzen, konkret auf Dateien/Klassen bezogen"
}

"rework" nur bei echten, konkret benennbaren Abweichungen vom Design-Konzept – nicht für Geschmacksfragen, die das Konzept offen lässt.`,
  });

  const verdict = readDesignVerdict(text);
  await logActivity({
    projectId: input.projectId,
    ticketId: input.ticketId,
    actor: designer.name,
    agentId: designer.id,
    action: verdict.verdict === "rework" ? "design_review_rework" : "design_review_approved",
    detail: `„${input.ticketTitle}": ${verdict.verdict === "rework" ? "Nacharbeit nötig" : "freigegeben"} – ${verdict.comment.slice(0, 300)}`,
  });

  return { ...verdict, reviewerName: designer.name };
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
