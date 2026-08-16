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
  listTrackedFiles,
  partitionSafeChanges,
  readRepoFile,
  repoOverview,
  writeFiles,
} from "@/lib/workspace";
import { agentForRole } from "@/lib/team";
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { continueSprint, loadWorkingProject } from "../orchestration";
import { enqueueAgentJob } from "../queue";
import { parseImplementation } from "../fileBlocks";
import type { TicketWorkPayload } from "../taskTypes";

/// Nach so vielen Anläufen hört das Team auf, ein Ticket allein lösen zu
/// wollen, und holt den Menschen dazu – wie ein Kollege, der nach dem zweiten
/// Versuch fragt statt weiter zu probieren.
const MAX_ATTEMPTS = 2;

/// Zeichen-Budget für den Quellcode im Prompt. Lieber weniger Dateien mit
/// vollem Inhalt als alles angeschnitten.
const SOURCE_BUDGET = 60_000;

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

/// Der bestehende Code als Arbeitsgrundlage. Die Auftragsunterlagen unter
/// `docs/` bleiben draußen – die stehen schon im Projektkontext.
async function readSourceContext(dir: string): Promise<string> {
  const files = (await listTrackedFiles(dir)).filter((file) => !file.startsWith("docs/"));

  const chunks: string[] = [];
  let used = 0;
  for (const file of files) {
    const content = await readRepoFile(dir, file);
    if (content === null) continue;
    if (used + content.length > SOURCE_BUDGET) {
      // Der Agent soll wissen, dass es die Datei gibt – sie aber nicht aus dem
      // Gedaechtnis neu schreiben. Eine vollstaendig zurueckgegebene Datei
      // ueberschreibt die echte, das waere Datenverlust.
      chunks.push(`--- ${file} (Inhalt nicht mitgeschickt – diese Datei NICHT ändern) ---`);
      continue;
    }
    used += content.length;
    chunks.push(`--- ${file} ---\n${content}`);
  }

  return chunks.join("\n\n") || "(noch keine Quelldateien)";
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
    await logActivity({
      projectId,
      actor: "Scrumy",
      action: "team_blocked",
      detail: "Kein Arbeitsverzeichnis – der Kickoff ist nicht durchgelaufen.",
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
  const ticketHead =
    `## Ticket\n${ticket.title}\nTyp: ${TICKET_TYPE_LABEL[ticket.type]} · Priorität: ${PRIORITY_LABEL[ticket.priority]}` +
    `${ticket.isCritical ? " · kritisch (braucht menschliche Freigabe)" : ""}\n\n${ticket.description ?? ""}`;

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: "IN_PROGRESS" } });
  await logActivity({
    projectId,
    ticketId,
    actor: implementer.name,
    agentId: implementer.id,
    action: attempt === 1 ? "ticket_started" : "ticket_reworked",
    detail: attempt === 1 ? `„${ticket.title}" übernommen` : `„${ticket.title}" – Nacharbeit nach QA-Review (Anlauf ${attempt})`,
  });

  const context = await buildProjectContext(projectId);

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

## Bestehender Code
${await repoOverview(dir)}

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
  const implementation = await runAgent({
    agent: implementer,
    projectId,
    ticketId,
    sprintId: ticket.sprintId ?? undefined,
    kind: "implementation",
    headline: `Setzt Ticket „${ticket.title}" um`,
    maxTokens: 16000,
    // Umsetzung heisst mehrere vollstaendige Dateien in einer Antwort – das
    // dauert je nach Modell viele Minuten.
    timeoutMs: 900_000,
    system: `${TEAM_GRUNDREGELN}

Du bist ${implementer.name} und setzt das Ticket im Repository um. Du antwortest ausschließlich im vorgegebenen Blockformat, ohne Vorrede.`,
    prompt: `${context}

${ticketHead}

## Umsetzungsplan
${plan}

## Bestehender Code
${await readSourceContext(dir)}

Die Auftragsunterlagen (docs/konzept.md, docs/anforderungen.md, docs/verstaendnis.md und docs/sprints/…) sind der eingefrorene Auftrag – die änderst du nicht. Eigene Dokumentation legst du woanders ab, z.B. unter docs/technik/.

Setze das Ticket um. Gib jede Datei, die du anlegst oder änderst, VOLLSTÄNDIG zurück (kein Diff, keine Auslassungen wie "..."). Dateien, die du nicht anfasst, lässt du weg. Schreibe lauffähigen, in sich stimmigen Code und passe bestehende Dateien an, statt sie zu duplizieren.

Antworte genau in diesem Format – der Dateiinhalt steht wörtlich zwischen den Markierungen, ohne Code-Fence und ohne Escaping:

COMMIT: Betreffzeile im Imperativ, max. 72 Zeichen
ZUSAMMENFASSUNG: 2-4 Sätze für den Auftraggeber: was jetzt anders ist und warum
OFFEN: offene Punkte oder Annahmen (weglassen, wenn es keine gibt)
--- DATEI: relativer/pfad.ts ---
vollständiger Dateiinhalt
--- DATEI: naechste/datei.md ---
vollständiger Dateiinhalt
--- ENDE ---`,
  });

  const result = parseImplementation(implementation.text);
  const { accepted: safeFiles, rejected: unsafe } = partitionSafeChanges(dir, result.files);
  const files = safeFiles.filter((file) => !isProtected(file.path));
  const rejected = [
    ...unsafe,
    ...safeFiles
      .filter((file) => isProtected(file.path))
      .map((file) => ({ path: file.path, reason: "Auftragsunterlage – wird nicht von Umsetzern geändert" })),
  ];
  const summary = result.summary || "Ohne Zusammenfassung.";
  const notes = result.notes;

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
      data: { status: "IN_REVIEW", result: `${summary}\n\n(Keine Dateiänderungen geliefert.)` },
    });
    await logActivity({
      projectId,
      ticketId,
      actor: implementer.name,
      agentId: implementer.id,
      action: "ticket_without_changes",
      detail: `„${ticket.title}": keine Dateiänderungen geliefert – wartet auf den Menschen`,
    });
    await requestHumanReview(projectId, ticketId, ticket.title, "Der Agent hat keine Änderungen geliefert.");
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
    data: { status: "IN_REVIEW", result: summary },
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
  "verdict": "approve" | "rework",
  "comment": "Begründung in 2-5 Sätzen, konkret auf Dateien bezogen",
  "risk": "low" | "medium" | "high"
}

"rework" nur bei echten Mängeln, nicht für Geschmacksfragen.`,
  });

  const { verdict, comment, risk } = readVerdict(review.text);

  await logActivity({
    projectId,
    ticketId,
    actor: reviewer.name,
    agentId: reviewer.id,
    action: verdict === "approve" ? "review_approved" : "review_rework",
    detail: `„${ticket.title}": ${verdict === "approve" ? "freigegeben" : "Nacharbeit nötig"} (Risiko ${risk || "unbekannt"}) – ${comment.slice(0, 300)}`,
  });

  if (verdict === "rework" && attempt < MAX_ATTEMPTS) {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: "IN_PROGRESS",
        result: `${summary}\n\nQA (${reviewer.name}): ${comment}`,
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
      data: { result: `${summary}\n\nQA (${reviewer.name}): ${comment}` },
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

/// Liest das QA-Urteil. Faellt das JSON aus dem Rahmen, wird die Antwort im
/// Klartext ausgewertet statt den ganzen Ticket-Lauf scheitern zu lassen: Der
/// Code ist an dieser Stelle schon committet, und ein unlesbares Urteil ist
/// kein Grund, die Arbeit zu verwerfen. Im Zweifel gilt Nacharbeit – lieber
/// ein zweiter Blick als eine Freigabe, die niemand gegeben hat.
function readVerdict(text: string): { verdict: "approve" | "rework"; comment: string; risk: string } {
  try {
    const data = extractJsonObject(text);
    return {
      verdict: String(data.verdict ?? "").toLowerCase() === "rework" ? "rework" : "approve",
      comment: String(data.comment ?? "").trim() || "(ohne Kommentar)",
      risk: String(data.risk ?? "").toLowerCase(),
    };
  } catch {
    const lower = text.toLowerCase();
    const approved = lower.includes("approve") && !lower.includes("rework");
    return {
      verdict: approved ? "approve" : "rework",
      comment: text.trim().slice(0, 2000) || "(unlesbare Antwort)",
      risk: "unbekannt",
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
