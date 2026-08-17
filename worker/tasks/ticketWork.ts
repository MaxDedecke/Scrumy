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
import {
  commitAll,
  gitShow,
  partitionSafeChanges,
  readRepoFile,
  readRelevantSourceContext,
  repoOverview,
  safeRepoPath,
  writeFiles,
  type FileChange,
} from "@/lib/workspace";
import { agentForRole, roleForTicket } from "@/lib/team";
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { optionsFromAgent, type ClarificationOption } from "@/lib/clarificationOptions";
import { AgentRunError, logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject } from "../orchestration";
import { openClarification } from "../clarification";
import { enqueueAgentJob } from "../queue";
import { parseImplementation } from "../fileBlocks";
import type { TicketWorkPayload } from "../taskTypes";

/// Nach so vielen Anläufen hört das Team auf, ein Ticket allein lösen zu
/// wollen, und holt den Menschen dazu – wie ein Kollege, der nach dem zweiten
/// Versuch fragt statt weiter zu probieren.
const MAX_ATTEMPTS = 2;

function clipForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} Zeichen für diesen Arbeitsschritt ausgeblendet)`;
}

/// Der Auftrag und was das Team dazu festgehalten hat, gehört nicht den
/// Umsetzern: Konzept, Anforderungen, Projektverständnis und Sprint-Dokumente
/// sind Belege gegenüber dem Auftraggeber. Ein Coding-Agent, der sie
/// „nebenbei" neu schreibt, verfälscht genau die Unterlagen, an denen später
/// gemessen wird – deshalb werden solche Änderungen verworfen und protokolliert.
const PROTECTED_PATHS = [
  /^docs\/konzept\.md$/i,
  /^docs\/anforderungen\.md$/i,
  /^docs\/verstaendnis\.md$/i,
  /^docs\/sprints\//i,
];

function isProtected(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return PROTECTED_PATHS.some((pattern) => pattern.test(normalized));
}

/// Markiert im Ticket-Ergebnis die Liste abgelehnter Dateien, damit ein
/// erneuter Anlauf sie wiederfindet (siehe rejectedPathsFromResult).
const REJECTED_FILES_MARKER = "Abgelehnte Änderungen:";

function formatRejectedFiles(rejected: { path: string; reason: string }[]): string {
  return `${REJECTED_FILES_MARKER}\n${rejected.map((file) => `- ${file.path}: ${file.reason}`).join("\n")}`;
}

/// Welche Dateien beim letzten Anlauf an einem SEARCH/REPLACE gescheitert
/// sind. Ohne das wiederholt ein zweiter Anlauf denselben Fehler blind: Der
/// Coding-Agent bekommt denselben Plan und denselben Bestandscode zu sehen
/// und schreibt mit hoher Wahrscheinlichkeit wieder einen SEARCH-Ausschnitt,
/// der nicht exakt passt. Diese Pfade dürfen deshalb ausnahmsweise komplett
/// (DATEI statt EDIT) ersetzt werden.
function rejectedPathsFromResult(result: string | null): Set<string> {
  if (!result || !result.includes(REJECTED_FILES_MARKER)) return new Set();
  const section = result.slice(result.indexOf(REJECTED_FILES_MARKER) + REJECTED_FILES_MARKER.length);
  const paths = [...section.matchAll(/^-\s*(\S+):/gm)].map((match) => match[1]);
  return new Set(paths);
}

interface MaterializedChanges {
  files: FileChange[];
  rejected: { path: string; reason: string }[];
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

/** Wendet die kompakten, exakten Such-/Ersetzungsblöcke erst im Speicher an. */
async function materializeChanges(
  dir: string,
  result: ReturnType<typeof parseImplementation>,
  /** Pfade, deren EDIT-Block im vorigen Anlauf abgelehnt wurde – für sie ist
   *  ein DATEI-Block ausnahmsweise auch für eine bestehende Datei erlaubt. */
  retryFullFileFor: Set<string> = new Set(),
): Promise<MaterializedChanges> {
  const changed = new Map<string, string>();
  const rejected: MaterializedChanges["rejected"] = [];

  for (const edit of result.edits) {
    try {
      safeRepoPath(dir, edit.path);
      const current = changed.get(edit.path) ?? await readRepoFile(dir, edit.path);
      if (current === null) {
        rejected.push({ path: edit.path, reason: "Datei existiert nicht – für neue Dateien DATEI verwenden" });
        continue;
      }
      const occurrences = current.split(edit.search).length - 1;
      if (occurrences !== 1) {
        rejected.push({
          path: edit.path,
          reason: occurrences === 0
            ? "SEARCH-Ausschnitt wurde nicht gefunden"
            : `SEARCH-Ausschnitt ist nicht eindeutig (${occurrences} Treffer)`,
        });
        continue;
      }
      changed.set(edit.path, current.replace(edit.search, edit.replace));
    } catch (error) {
      rejected.push({ path: edit.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const file of result.files) {
    try {
      safeRepoPath(dir, file.path);
      const exists = await readRepoFile(dir, file.path) !== null;
      if ((exists || changed.has(file.path)) && !retryFullFileFor.has(file.path)) {
        rejected.push({ path: file.path, reason: "Datei existiert bereits – für bestehende Dateien EDIT verwenden" });
        continue;
      }
      changed.set(file.path, file.content);
    } catch (error) {
      rejected.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { files: [...changed].map(([path, content]) => ({ path, content })), rejected };
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
  // Dateien, deren EDIT-Block beim letzten Anlauf abgelehnt wurde. Steht im
  // ticket.result, sobald ein Anlauf Dateien abgelehnt hat – unabhängig vom
  // attempt-Zähler, der bei einer menschlichen Zurückweisung wieder bei 1
  // anfängt. Ohne diese Erinnerung sieht ein erneuter Anlauf denselben Plan
  // und denselben Bestandscode und schreibt mit hoher Wahrscheinlichkeit
  // wieder einen SEARCH-Ausschnitt, der nicht exakt passt.
  const previouslyRejectedPaths = rejectedPathsFromResult(ticket.result);
  const ticketHead =
    `## Ticket\n${ticket.title}\nTyp: ${TICKET_TYPE_LABEL[ticket.type]} · Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
    `${ticket.isCritical ? " · kritisch (braucht menschliche Freigabe)" : ""}\n\n${clipForPrompt(ticket.description ?? "", 6000)}`;

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: "IN_PROGRESS" } });
  await logActivity({
    projectId,
    ticketId,
    actor: implementer.name,
    agentId: implementer.id,
    action: attempt === 1 ? "ticket_started" : "ticket_reworked",
    detail: attempt === 1 ? `„${ticket.title}" übernommen` : `„${ticket.title}" – Nacharbeit nach QA-Review (Anlauf ${attempt})`,
  });

  const focus = `${ticket.title}\n${ticket.description ?? ""}`;
  const context = await buildProjectContext(projectId, {
    includeRepo: false,
    includeBoard: false,
    compact: true,
    focus,
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

  // --- 2. Umsetzung ---------------------------------------------------------
  const planForPrompt = clipForPrompt(plan, 8000);
  const sourceQuery = `${focus}\n${planForPrompt}`;
  let implementation;
  try {
    implementation = await runAgent({
      agent: implementer,
      projectId,
      ticketId,
      sprintId: ticket.sprintId ?? undefined,
      kind: "implementation",
      headline: `Setzt Ticket „${ticket.title}" um`,
      maxTokens: 16000,
      // Auch kompakte Edits koennen bei langsamen lokalen Modellen dauern.
      timeoutMs: 900_000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${implementer.name} und setzt das Ticket im Repository um. Du antwortest ausschließlich im vorgegebenen Blockformat, ohne Vorrede.`,
      prompt: `${context}

${ticketHead}

## Umsetzungsplan
${planForPrompt}

## Bestehender Code
${await readRelevantSourceContext(dir, sourceQuery)}
${previouslyRejectedPaths.size > 0
  ? `\n## Vorheriger Anlauf ist gescheitert\nBei folgenden Dateien passte der SEARCH-Ausschnitt nicht exakt (oder mehrfach) auf den heutigen Stand: ${[...previouslyRejectedPaths].join(", ")}. Kopiere den SEARCH-Text diesmal Zeichen für Zeichen aus „Bestehender Code" oben, inklusive Einrückung – oder, falls die Änderung ohnehin den Großteil der Datei betrifft, gib genau diese Dateien ausnahmsweise vollständig in einem DATEI-Block zurück (nur für die hier genannten Pfade erlaubt).\n`
  : ""}
Die Auftragsunterlagen (docs/konzept.md, docs/anforderungen.md, docs/verstaendnis.md und docs/sprints/…) sind der eingefrorene Auftrag – die änderst du nicht. Eigene Dokumentation legst du woanders ab, z.B. unter docs/technik/.

Setze ausschließlich dieses kleine Ticket um. Ändere bestehende Dateien mit exakten SEARCH/REPLACE-Blöcken; kopiere in SEARCH genug unveränderten Kontext, damit der Ausschnitt genau einmal vorkommt. Gib bestehende Dateien niemals vollständig zurück – Ausnahme ist ein oben unter „Vorheriger Anlauf ist gescheitert" ausdrücklich genannter Pfad. Nur NEUE Dateien (und diese Ausnahme) kommen vollständig in einen DATEI-Block. Dateien, die du nicht anfasst, lässt du weg.

Wenn Auftrag und Anforderungen sich an einer Stelle widersprechen oder etwas Wesentliches offen lassen, das du nicht selbst entscheiden darfst (Fachlogik, Datenhaltung, Kosten, Rechte): Erfinde nichts. Setze um, was zweifelsfrei ist, und stelle die Frage im Feld KLÄRUNG – der Auftraggeber entscheidet, und das Team arbeitet danach mit dem Beschluss weiter.

Zu jeder Klärung gehören die Wege, zwischen denen entschieden wird: Schreibe sie ins Feld WEGE, zwei bis vier Stück, jeden in einer eigenen Zeile als „Kurzer Titel: was das konkret bedeutet, mit Für und Wider in einem Satz". Es sind die fachlichen Möglichkeiten, die DU siehst (welcher Server, welches Datenmodell, welche Bibliothek) – nicht „nochmal versuchen" oder „abbrechen", die kennt Scrumy selbst.

Antworte genau in diesem Format, ohne Code-Fences und ohne Escaping. Wiederhole EDIT-Blöcke, wenn eine Datei mehrere getrennte Stellen ändert:

COMMIT: Betreffzeile im Imperativ, max. 72 Zeichen
ZUSAMMENFASSUNG: 2-4 Sätze für den Auftraggeber: was jetzt anders ist und warum
OFFEN: offene Punkte oder Annahmen (weglassen, wenn es keine gibt)
KLÄRUNG: eine einzelne Frage an den Auftraggeber (nur wenn du wirklich nicht entscheiden darfst, sonst weglassen)
WEGE: erster Weg: was das heißt
- zweiter Weg: was das heißt
--- EDIT: bestehender/pfad.ts ---
<<< SEARCH
exakt vorhandener, eindeutig vorkommender Ausschnitt
=== REPLACE
neuer Ausschnitt
>>> END EDIT
--- DATEI: nur/neue/datei.ts ---
vollständiger Inhalt der neuen Datei
--- ENDE ---`,
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
    throw error;
  }

  const result = parseImplementation(implementation.text);
  const materialized = await materializeChanges(dir, result, previouslyRejectedPaths);
  const { accepted: safeFiles, rejected: unsafe } = partitionSafeChanges(dir, materialized.files);
  const files = safeFiles.filter((file) => !isProtected(file.path));
  const rejected = [
    ...materialized.rejected,
    ...unsafe,
    ...safeFiles
      .filter((file) => isProtected(file.path))
      .map((file) => ({ path: file.path, reason: "Auftragsunterlage – wird nicht von Umsetzern geändert" })),
  ];
  const summary = result.summary || "Ohne Zusammenfassung.";
  const notes = result.notes;
  // Auch wenn ein Teil der Änderungen committet wird, muss der Rest, den QA
  // vielleicht vermisst, im Ergebnis stehen bleiben – sonst hat der nächste
  // Anlauf keine Ahnung, welche Datei am Ende doch nicht angefasst wurde.
  const rejectedSuffix = rejected.length > 0 ? `\n\n${formatRejectedFiles(rejected)}` : "";
  // Eine Frage an den Auftraggeber muss eine Frage sein. Ein Rest aus einem
  // Formatfehler des Modells darf kein Ticket blockieren, bis ihn jemand
  // wegklickt – deshalb die Mindestlaenge.
  const raisedQuestion = result.clarification.length >= 15 ? result.clarification : "";
  // Die Wege, die der Umsetzer selbst sieht. Sie sind die einzigen fachlichen
  // Vorschlaege, die es sofort gibt – die ausgearbeitete Vorlage des Scrum
  // Masters kommt erst einen Modellaufruf spaeter.
  const raisedOptions = raisedQuestion ? optionsFromAgent(result.clarificationOptions) : [];

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
    // Nichts geliefert heisst: Es gibt nichts freizugeben. Frueher landete das
    // trotzdem als Freigabe-Anfrage beim Menschen – eine Freigabe fuer eine
    // leere Aenderung. Jetzt ist es die Frage, die es tatsaechlich ist.
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: "IN_PROGRESS",
        result: `${summary}\n\n(Keine Dateiänderungen geliefert.)` +
          (rejected.length > 0 ? `\n\n${formatRejectedFiles(rejected)}` : ""),
      },
    });
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

  const written = await writeFiles(dir, files);
  const subject = (result.commitMessage.split("\n")[0] || ticket.title).slice(0, 120);
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

Prüfe: Erfüllt die Änderung das Ticket? Ist der Code in sich stimmig und passt er zum bestehenden Stand? Fehlt etwas Offensichtliches?

Antworte nur mit diesem JSON-Objekt:
{
  "verdict": "approve" | "rework" | "needs_decision",
  "comment": "Begründung in 2-5 Sätzen, konkret auf Dateien bezogen",
  "risk": "low" | "medium" | "high",
  "wege": [{ "label": "kurzer Titel", "detail": "was das konkret heißt, mit Für und Wider in 1-2 Sätzen" }]
}

"rework" nur bei echten Mängeln, nicht für Geschmacksfragen.
"needs_decision", wenn das Team die Frage gar nicht selbst beantworten kann – wenn Auftrag und Anforderungen sich widersprechen oder etwas Fachliches offen lassen. Schreibe dann in "comment" die Frage, die der Auftraggeber entscheiden muss. Nacharbeit hilft in dem Fall nicht: Ein zweiter Anlauf würde dieselbe Lücke nur anders raten.
"wege" nur bei "needs_decision": zwei bis vier fachliche Möglichkeiten, zwischen denen der Auftraggeber wählt – nicht „nochmal versuchen" oder „abbrechen", die kennt Scrumy selbst. Sonst leer lassen.`,
  });

  const { verdict, comment, risk, options: reviewOptions } = readVerdict(review.text);

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
    await requestHumanReview(projectId, ticketId, ticket.title, `QA sieht nach ${attempt} Anläufen weiter Mängel: ${comment}`);
  } else if (ticket.isCritical || risk === "high") {
    await requestHumanReview(
      projectId,
      ticketId,
      ticket.title,
      ticket.isCritical
        ? `Kritisches Ticket – QA hat freigegeben: ${comment}`
        : `QA stuft das Risiko als hoch ein: ${comment}`,
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
async function requestHumanReview(projectId: string, ticketId: string, title: string, why: string) {
  const existing = await prisma.reviewApproval.findFirst({ where: { ticketId, decision: "PENDING" } });
  if (!existing) {
    await prisma.reviewApproval.create({
      data: { ticketId, reviewerName: "Mensch", comment: why.slice(0, 2000) },
    });
  }
  await prisma.ticket.update({ where: { id: ticketId }, data: { status: "IN_REVIEW" } });
  await logActivity({
    projectId,
    ticketId,
    actor: "Scrumy",
    action: "human_review_requested",
    detail: `„${title}" wartet auf eine menschliche Freigabe: ${why.slice(0, 300)}`,
  });
}

export default ticketWork;
