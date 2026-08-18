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
- Beschlüsse des Auftraggebers stehen über deiner eigenen Einschätzung und gelten weiter, auch wenn sie Wochen alt sind.
- Architektur-Standard, kein Vorschlag: Die Software läuft als Docker-Compose-Umgebung mit einem eigenen Container je Dienst (Microservice-Zuschnitt statt Monolith, z.B. getrennte Container für Frontend, Backend/API und Datenbank). Als Datenbank ist ein eigener Postgres-Container der Standard-Dienst in diesem Zuschnitt – plane ihn bei jedem Projekt automatisch mit ein. Lass ihn nur weg, wenn das Projekt wirklich ohne Datenhaltung auskommt (seltener Ausnahmefall, z.B. ein zustandsloses Werkzeug ohne jede Persistenz); in dem Fall nenne im Projektverständnis kurz, warum keine Datenbank nötig ist. Gibt es ein Frontend, bekommt es einen eigenen Container in einem konventionellen Verzeichnis ('frontend/', 'web/', 'client/', 'app/', 'ui/' oder Projektwurzel) mit einem 'dev'-, 'start'- oder 'preview'-Skript in dessen package.json – daran erkennt und startet Scrumys Vorschau-Funktion es automatisch. Weiche vom Zuschnitt (Container je Dienst, inkl. Datenbank) nur ab, wenn (a) Konzept, Anforderungen oder ein Beschluss des Auftraggebers ausdrücklich etwas anderes verlangen, (b) das Projekt kein Frontend hat (reiner Service/reine API – dann ist Docker optional), oder (c) bestehender Code importiert wird, der schon eine andere Struktur mitbringt. Sonst gilt dieser Zuschnitt, ohne dass ihn jemand extra anfordern muss. Die docker-compose.yml selbst liegt in der Repo-Wurzel und ist ausführbar, ohne dass irgendwer sie von Hand anpasst – Scrumys "Anwendung starten"-Funktion und die automatische Sprint-Integrationsprüfung führen genau diese Datei per "docker compose up" aus. Container kopieren ihren Code dafür beim Build (COPY im Dockerfile), statt ihn zur Laufzeit per Bind-Mount aus dem Projektverzeichnis einzuhängen – letzteres funktioniert in Scrumys Umgebung nicht zuverlässig. Veröffentliche ("ports:") nur den einen Dienst, den ein Mensch im Browser direkt öffnet (typischerweise das Frontend) – alle anderen (Backend/API, Datenbank) sprechen sich ausschließlich über den Compose-Servicenamen im internen Netz an (z.B. "http://backend:3000"), auch wenn ihr das der Übersichtlichkeit halber trotzdem fest verdrahtet. Ein zusätzlicher "ports:"-Eintrag für sie bringt nichts (kein Browser greift direkt darauf zu) und kann auf Scrumys Host mit dem festen Port eines ganz anderen, gleichzeitig laufenden Projekts kollidieren – der Start scheitert dann mit "port is already allocated".
- Wo der Auftrag widersprüchlich oder lückenhaft ist, rate nicht: Sag es und lass entscheiden.
- Was du tust, muss für den Auftraggeber nachvollziehbar sein: begründe Entscheidungen kurz.`;

/// Kappt lange Texte fuer den Prompt, statt ein ganzes Lastenheft mitzuschicken.
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (gekürzt, ${text.length - maxChars} Zeichen mehr)`;
}

export async function buildProjectContext(
  projectId: string,
  options: { includeRepo?: boolean; includeBoard?: boolean; compact?: boolean; focus?: string } = {},
): Promise<string> {
  const { includeRepo = true, includeBoard = true, compact = false, focus = "" } = options;

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
      clip(releasedConcept?.content ?? project.concept?.content ?? "(kein Konzept hinterlegt)", compact ? 5000 : 12000),
  );

  // Das Beschlussregister: Was der Auftraggeber in Klaerungen entschieden hat,
  // gehoert in JEDEN Prompt. Ohne das laeuft das Team in vier Wochen in
  // dieselbe Frage – und entscheidet sie dann womoeglich anders als er.
  const [decisions, openClarifications] = await Promise.all([
    prisma.clarification.findMany({
      where: { projectId, status: "DECIDED" },
      orderBy: { decidedAt: "desc" },
      take: compact ? 8 : 20,
      include: { ticket: { select: { title: true } } },
    }),
    prisma.clarification.findMany({
      where: { projectId, status: "OPEN" },
      orderBy: { createdAt: "asc" },
      ...(compact ? { take: 10 } : {}),
      include: { ticket: { select: { title: true } } },
    }),
  ]);

  const focusTerms = focus.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((term) => term.length >= 4);
  const orderedRequirements = compact && focusTerms.length > 0
    ? [...project.requirements].sort((a, b) => {
        const score = (value: typeof a) => {
          const text = `${value.title} ${value.description ?? ""}`.toLowerCase();
          return focusTerms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
        };
        return score(b) - score(a);
      })
    : project.requirements;

  let requirementChars = 0;
  const requirementBudget = compact ? 6000 : Number.POSITIVE_INFINITY;
  const requirements = orderedRequirements
    .map((requirement, index) => {
      const head = `${index + 1}. [${PRIORITY_LABEL[requirement.priority]}] ${requirement.title}`;
      const detail = requirement.description ? `\n   ${clip(requirement.description, compact ? 500 : 800)}` : "";
      const file = requirement.fileName ? `\n   (Anhang: ${requirement.fileName})` : "";
      return head + detail + file;
    })
    .filter((entry) => {
      if (requirementChars + entry.length > requirementBudget) return false;
      requirementChars += entry.length;
      return true;
    })
    .join("\n");
  parts.push(`# Freigegebene Anforderungen\n${requirements || "(keine erfasst)"}`);

  if (decisions.length > 0) {
    const register = decisions
      .reverse()
      .map((entry) => {
        const when = (entry.decidedAt ?? entry.createdAt).toLocaleDateString("de-DE");
        const subject = entry.ticket ? ` (Ticket „${entry.ticket.title}")` : "";
        return `- ${when}${subject}\n  Frage: ${clip(entry.question, 400)}\n  Beschluss: ${clip(entry.decision ?? "", 800)}`;
      })
      .join("\n");
    parts.push(
      `# Beschlüsse des Auftraggebers\nDiese Entscheidungen sind getroffen und gelten. Halte dich daran, auch wenn du es anders lösen würdest.\n${register}`,
    );
  }

  if (openClarifications.length > 0) {
    const pending = openClarifications
      .map((entry) => `- ${entry.ticket ? `„${entry.ticket.title}": ` : ""}${clip(entry.question, 400)}`)
      .join("\n");
    parts.push(
      `# Offene Klärungen\nDarauf wartet das Team noch. Triff diese Entscheidungen nicht selbst und arbeite nicht an den betroffenen Punkten weiter.\n${pending}`,
    );
  }

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
