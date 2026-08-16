// Der gemeinsame Wissensstand des Teams, so wie ihn jeder Agent im Prompt
// bekommt: Kunde, Auftrag (freigegebenes Konzept), Anforderungen und der
// aktuelle Stand von Repo und Board.
//
// Bewusst als Text und nicht als JSON-Dump: Das ist die "Projektakte", die ein
// neuer Kollege am ersten Tag liest – und sie ist genau das, was spaeter im
// Audit unter `AgentRun.prompt` nachlesbar ist.
import { prisma } from "@/lib/prisma";
import { PRIORITY_LABEL, TICKET_STATUS_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels";
import { repoOverview } from "@/lib/workspace";

export const TEAM_GRUNDREGELN = `Du arbeitest als Mitglied eines festen Entwicklungsteams einer Software-Beratung.
Ihr baut die Individualsoftware eines Kunden in einem lokalen Git-Repository und arbeitet nach Scrum.

Grundregeln:
- Antworte immer auf Deutsch, sachlich und knapp, wie ein Kollege im Team.
- Erfinde keine Tatsachen über den Projektstand. Was du nicht weißt, sagst du.
- Halte dich an das freigegebene Konzept und die freigegebenen Anforderungen; sie sind der Auftrag.
- Was du tust, muss für den Auftraggeber nachvollziehbar sein: begründe Entscheidungen kurz.`;

/// Kappt lange Texte fuer den Prompt, statt ein ganzes Lastenheft mitzuschicken.
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (gekürzt, ${text.length - maxChars} Zeichen mehr)`;
}

export async function buildProjectContext(
  projectId: string,
  options: { includeRepo?: boolean; includeBoard?: boolean } = {},
): Promise<string> {
  const { includeRepo = true, includeBoard = true } = options;

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      organization: true,
      concept: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } },
      requirements: { orderBy: { createdAt: "asc" } },
    },
  });

  const parts: string[] = [];

  parts.push(
    `# Projekt\nKunde: ${project.organization.name}${project.organization.industry ? ` (${project.organization.industry})` : ""}\n` +
      `Projekt: ${project.name}\n` +
      (project.description ? `Kurzbeschreibung: ${project.description}\n` : ""),
  );

  const releasedConcept = project.concept?.versions[0];
  parts.push(
    `# Freigegebenes Konzept${releasedConcept ? ` (Version ${releasedConcept.version})` : ""}\n` +
      clip(releasedConcept?.content ?? project.concept?.content ?? "(kein Konzept hinterlegt)", 12000),
  );

  const requirements = project.requirements
    .map((requirement, index) => {
      const head = `${index + 1}. [${PRIORITY_LABEL[requirement.priority]}] ${requirement.title}`;
      const detail = requirement.description ? `\n   ${clip(requirement.description, 800)}` : "";
      const file = requirement.fileName ? `\n   (Anhang: ${requirement.fileName})` : "";
      return head + detail + file;
    })
    .join("\n");
  parts.push(`# Freigegebene Anforderungen\n${requirements || "(keine erfasst)"}`);

  if (includeBoard) {
    const [sprint, tickets] = await Promise.all([
      prisma.sprint.findFirst({ where: { projectId }, orderBy: { number: "desc" } }),
      prisma.ticket.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
        include: { assignee: true, sprint: true },
      }),
    ]);

    const board = tickets
      .map(
        (ticket) =>
          `- [${TICKET_STATUS_LABEL[ticket.status]}] ${ticket.title} (${TICKET_TYPE_LABEL[ticket.type]}, ` +
          `${PRIORITY_LABEL[ticket.priority]}${ticket.sprint ? `, Sprint ${ticket.sprint.number}` : ""}` +
          `${ticket.assignee ? `, ${ticket.assignee.name}` : ""})`,
      )
      .join("\n");

    parts.push(
      `# Scrum-Board\n${sprint ? `Aktueller Sprint: ${sprint.number} – Ziel: ${sprint.goal}` : "Noch kein Sprint geplant."}\n` +
        `${board || "(noch keine Tickets)"}`,
    );
  }

  if (includeRepo && project.workspacePath) {
    parts.push(`# Repository\n${await repoOverview(project.workspacePath)}`);
  }

  return parts.join("\n\n");
}
