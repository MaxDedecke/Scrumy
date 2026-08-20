// Erster Arbeitstag des Teams.
//
// Reihenfolge wie in einer echten Firma: Erst wird der Arbeitsplatz
// eingerichtet (lokales Git-Repo), dann werden die Auftragsunterlagen
// abgelegt (Konzept + Anforderungen wandern als Dateien ins Repo), und erst
// dann liest der Product Owner den Auftrag und schreibt auf, wie das Team ihn
// verstanden hat. Dieses Verständnis-Dokument ist der erste Beleg, an dem der
// Auftraggeber merkt, ob das Team ihn richtig verstanden hat – bevor eine
// einzige Zeile Code entsteht.
import type { Task } from "graphile-worker";
import { prisma } from "@/lib/prisma";
import { PRIORITY_LABEL } from "@/lib/labels";
import { commitAll, ensureRepo, writeFiles } from "@/lib/workspace";
import { agentForRole } from "@/lib/team";
import { logActivity, runAgent } from "../agentRun";
import { buildProjectContext, TEAM_GRUNDREGELN } from "../projectContext";
import { handOverTo, loadWorkingProject } from "../orchestration";
import { remoteSettingsForProject } from "../projectRepository";
import type { TeamKickoffPayload } from "../taskTypes";

const teamKickoff: Task<"teamKickoff"> = async (payload: TeamKickoffPayload, helpers) => {
  const { agentId, projectId, reason } = payload;

  const project = await loadWorkingProject(projectId);
  if (!project) {
    helpers.logger.info(`Projekt ${projectId} ist nicht aktiv – Kickoff übersprungen.`);
    return;
  }

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const full = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      organization: true,
      concept: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } },
      requirements: { orderBy: { createdAt: "asc" } },
    },
  });

  // --- 1. Arbeitsplatz einrichten -------------------------------------------
  const remote = await remoteSettingsForProject(project);
  const { dir, created, cloned } = await ensureRepo(projectId, remote);
  if (project.workspacePath !== dir) {
    await prisma.project.update({ where: { id: projectId }, data: { workspacePath: dir } });
  }
  await logActivity({
    projectId,
    actor: agent.name,
    agentId: agent.id,
    action: cloned ? "repo_cloned" : created ? "repo_created" : "repo_reused",
    detail: cloned
      ? `Git-Repository von ${remote?.remoteUrl} geklont (${dir})`
      : created
        ? `Lokales Git-Repository angelegt (${dir})`
        : `Bestehendes Repository weiterverwendet (${dir})`,
  });

  // --- 2. Auftragsunterlagen ins Repo ---------------------------------------
  const concept = full.concept?.versions[0]?.content ?? full.concept?.content ?? "";
  const requirementList = full.requirements
    .map((requirement) => {
      const head = `## ${requirement.title}\n\n- Priorität: ${PRIORITY_LABEL[requirement.priority]}`;
      const attachment = requirement.fileName ? `\n- Anhang: ${requirement.fileName}` : "";
      const body = requirement.description ? `\n\n${requirement.description}` : "";
      return `${head}${attachment}${body}`;
    })
    .join("\n\n");

  await writeFiles(dir, [
    {
      path: "README.md",
      content:
        `# ${full.name}\n\n${full.description ?? ""}\n\n` +
        `Individualsoftware für **${full.organization.name}**, gebaut und gepflegt vom Agenten-Team der Beratung.\n\n` +
        `Der Auftrag liegt in \`docs/konzept.md\` und \`docs/anforderungen.md\`, das Verständnis des Teams in \`docs/verstaendnis.md\`.\n` +
        `Jeder Commit stammt von dem Teammitglied, das die Änderung verantwortet.\n`,
    },
    {
      path: "docs/konzept.md",
      content: `# Konzept (freigegeben${full.concept?.versions[0] ? `, Version ${full.concept.versions[0].version}` : ""})\n\n${concept}`,
    },
    {
      path: "docs/anforderungen.md",
      content: `# Anforderungen (freigegeben)\n\n${requirementList || "_(keine erfasst)_"}`,
    },
  ]);

  const docsCommit = await commitAll(dir, {
    message:
      "Auftragsunterlagen aufgenommen\n\nKonzept und freigegebene Anforderungen als Arbeitsgrundlage im Repository abgelegt.",
    authorName: agent.name,
  });
  if (docsCommit) {
    await logActivity({
      projectId,
      actor: agent.name,
      agentId: agent.id,
      action: "code_committed",
      detail: `${docsCommit.shortSha} · Auftragsunterlagen aufgenommen (${docsCommit.changedFiles} Dateien)`,
    });
  }

  // --- 3. Auftrag verstehen --------------------------------------------------
  const context = await buildProjectContext(projectId, { includeBoard: false });
  const { text } = await runAgent({
    agent,
    projectId,
    kind: "kickoff",
    headline: "Liest Konzept und Anforderungen und schreibt das Projektverständnis",
    maxTokens: 6000,
    system: `${TEAM_GRUNDREGELN}

Du bist ${agent.name}, Product Owner des Teams. Heute ist der erste Projekttag: Du liest den Auftrag und hältst fest, wie das Team ihn verstanden hat.`,
    prompt: `${context}

Schreibe das Dokument "Projektverständnis" als Markdown (ohne Code-Fence drumherum). Gliederung:

# Projektverständnis
## Was der Kunde erreichen will
## Umfang (was gehört dazu – und was ausdrücklich nicht)
## Fachliche Kernbegriffe
## Technischer Rahmen
(Technologie und Container-Zuschnitt, passend zu Konzept und Anforderungen – begründet, aber knapp. Docker-Compose mit einem Container je Dienst ist der Standard aus den Grundregeln; nenne konkret, welche Dienste es geben wird, und in welchem Verzeichnis ein etwaiges Frontend liegt. Weichst du davon ab, nenne ausdrücklich, welche der drei Ausnahmen aus den Grundregeln greift.)
## Annahmen
(Was wir annehmen, weil es im Auftrag nicht steht.)
## Risiken
## Offene Fragen an den Auftraggeber

Bleib bei dem, was in Konzept und Anforderungen steht. Keine Zeitschätzungen, keine Preise.`,
  });

  await writeFiles(dir, [{ path: "docs/verstaendnis.md", content: text }]);
  const understandingCommit = await commitAll(dir, {
    message: `Projektverständnis dokumentiert\n\nAusgearbeitet von ${agent.name} (Product Owner) auf Basis von Konzept und freigegebenen Anforderungen.`,
    authorName: agent.name,
  });

  await logActivity({
    projectId,
    actor: agent.name,
    agentId: agent.id,
    action: "kickoff_completed",
    detail: understandingCommit
      ? `${understandingCommit.shortSha} · Projektverständnis in docs/verstaendnis.md festgehalten`
      : "Projektverständnis erstellt (keine Änderung im Repository)",
  });

  // --- 4. Design-Konzept ------------------------------------------------
  // Gibt es einen eigenen Design-Agenten im Team, hält er vor dem ersten
  // Sprint fest, wie das Projekt konkret aussehen soll – sonst bleibt der
  // Design-Standard aus TEAM_GRUNDREGELN (Tailwind + shadcn/ui, Skalen,
  // Zustände) abstrakt, und jedes Frontend-Ticket würde neu raten, welche
  // Farben/Abstände gemeint sind. Das Dokument ist die Referenz, gegen die
  // spätere Frontend-Tickets geprüft werden (siehe ticketWork.ts).
  const designer = await agentForRole(projectId, "DESIGN");
  if (designer && designer.role === "DESIGN") {
    const { text: designText } = await runAgent({
      agent: designer,
      projectId,
      kind: "design_concept",
      headline: "Erarbeitet das Design-Konzept",
      maxTokens: 5000,
      system: `${TEAM_GRUNDREGELN}

Du bist ${designer.name}, verantwortlich für das Design-Konzept des Projekts. Du legst vor dem ersten Sprint fest, wie die Anwendung konkret aussehen soll – die Referenz, an der sich jedes Frontend-Ticket später messen lässt.`,
      prompt: `${context}

## Projektverständnis (gerade von ${agent.name} geschrieben)
${text}

Schreibe das Dokument "Design-Konzept" als Markdown (ohne Code-Fence). Gliederung:

# Design-Konzept
## Look & Feel
(Ton und Zielgruppe in 2-3 Sätzen – wonach soll die Anwendung sich anfühlen?)
## Farbpalette
(konkrete Werte für Primär-, Sekundär-, Neutral- und Status-Farben, als Tailwind-Tokens)
## Typografie
(Schriftfamilie, Größen-/Gewichts-Skala)
## Spacing & Layout-Raster
## Kernkomponenten
(welche shadcn/ui-Komponenten das Projekt durchgängig nutzt, z.B. Button, Card, Dialog, Table, Form)
## Zustände
(wie leer/lädt/Fehler bei Ansichten mit Daten konkret aussehen)
## Responsive-Verhalten

Hat dieses Projekt laut Projektverständnis kein Frontend, schreibe stattdessen nur einen kurzen Absatz, warum kein Design-Konzept nötig ist – erfinde keine Ansichten, die nicht gebaut werden.`,
    });

    await writeFiles(dir, [{ path: "docs/design-konzept.md", content: designText }]);
    const designCommit = await commitAll(dir, {
      message: `Design-Konzept festgelegt\n\nAusgearbeitet von ${designer.name} (Design) auf Basis des Projektverständnisses.`,
      authorName: designer.name,
    });
    await logActivity({
      projectId,
      actor: designer.name,
      agentId: designer.id,
      action: "design_concept_documented",
      detail: designCommit
        ? `${designCommit.shortSha} · Design-Konzept in docs/design-konzept.md festgehalten`
        : "Design-Konzept erstellt (keine Änderung im Repository)",
    });
  }

  helpers.logger.info(`Kickoff für Projekt ${full.name} abgeschlossen (${reason}).`);

  await handOverTo("PRODUCT_OWNER", "sprintPlanning", projectId, {
    reason: "Kickoff abgeschlossen – erster Sprint kann geplant werden",
  });
};

export default teamKickoff;
