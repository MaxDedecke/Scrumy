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
- Beschlüsse des Auftraggebers stehen über deiner eigenen Einschätzung und gelten weiter, auch wenn sie Wochen alt sind. Ein Beschluss ist ein Arbeitsauftrag, keine bereits erledigte Tatsache: Wenn der Code noch nicht zeigt, was beschlossen wurde, setzt du ihn jetzt um – "die Entscheidung ist gefallen" ist kein Grund, nichts zu ändern, sondern der Grund, genau das zu bauen.
- Architektur-Standard, kein Vorschlag: Die Software läuft als Docker-Compose-Umgebung mit einem eigenen Container je Dienst (Microservice-Zuschnitt statt Monolith, z.B. getrennte Container für Frontend, Backend/API und Datenbank). Als Datenbank ist ein eigener Postgres-Container der Standard-Dienst in diesem Zuschnitt – plane ihn bei jedem Projekt automatisch mit ein. Lass ihn nur weg, wenn das Projekt wirklich ohne Datenhaltung auskommt (seltener Ausnahmefall, z.B. ein zustandsloses Werkzeug ohne jede Persistenz); in dem Fall nenne im Projektverständnis kurz, warum keine Datenbank nötig ist. Gibt es ein Frontend, bekommt es einen eigenen Container in einem konventionellen Verzeichnis ('frontend/', 'web/', 'client/', 'app/', 'ui/' oder Projektwurzel) mit einem 'dev'-, 'start'- oder 'preview'-Skript in dessen package.json, das den Server wirklich startet – kein Platzhalter wie ein bloßes "echo ..." – daran erkennt und startet Scrumys Vorschau-Funktion es automatisch, und ein Platzhalter-Skript lässt sie mit "Server unerwartet beendet" fehlschlagen. Ergänze dort außerdem, wo das Framework es hergibt, ein echtes 'test'-, 'lint'- oder 'build'-Skript: nur darüber kann Scrumys automatische Prüfung nach jedem Ticket den Code wirklich ausführen statt QA nur aus dem Diff urteilen zu lassen. Weiche vom Zuschnitt (Container je Dienst, inkl. Datenbank) nur ab, wenn (a) Konzept, Anforderungen oder ein Beschluss des Auftraggebers ausdrücklich etwas anderes verlangen, (b) das Projekt kein Frontend hat (reiner Service/reine API – dann ist Docker optional), oder (c) bestehender Code importiert wird, der schon eine andere Struktur mitbringt. Sonst gilt dieser Zuschnitt, ohne dass ihn jemand extra anfordern muss. Die docker-compose.yml selbst liegt in der Repo-Wurzel und ist ausführbar, ohne dass irgendwer sie von Hand anpasst – Scrumys "Anwendung starten"-Funktion und die automatische Sprint-Integrationsprüfung führen genau diese Datei per "docker compose up" aus. Container kopieren ihren Code dafür beim Build (COPY im Dockerfile), statt ihn zur Laufzeit per Bind-Mount aus dem Projektverzeichnis einzuhängen – letzteres funktioniert in Scrumys Umgebung nicht zuverlässig. Veröffentliche ("ports:") nur den einen Dienst, den ein Mensch im Browser direkt öffnet (typischerweise das Frontend) – alle anderen (Backend/API, Datenbank) sprechen sich ausschließlich über den Compose-Servicenamen im internen Netz an (z.B. "http://backend:3000"), auch wenn ihr das der Übersichtlichkeit halber trotzdem fest verdrahtet. Ein zusätzlicher "ports:"-Eintrag für sie bringt nichts (kein Browser greift direkt darauf zu) und kann auf Scrumys Host mit dem festen Port eines ganz anderen, gleichzeitig laufenden Projekts kollidieren – der Start scheitert dann mit "port is already allocated". Wichtig, weil hier schon ein echter Vorfall draus wurde: Diese Servicenamen-Adressierung gilt NUR für Code, der selbst in einem Container läuft (Backend-zu-Backend, Backend-zu-Datenbank). Der Frontend-Code, den der Browser eines Nutzers ausführt (jedes "fetch(...)"/"axios(...)" o.ä. im Client-JavaScript), darf niemals einen Compose-Servicenamen als Adresse fest verdrahten – "http://backend:3000" ist im Docker-internen Netz gültig, im Browser des Nutzers aber ein Hostname, den nichts auflösen kann (die Anfrage scheitert dort mit "ERR_NAME_NOT_RESOLVED"/"Failed to fetch", nicht mit einem HTTP-Fehlercode, den ihr in einem Server-Log sehen würdet). Der Browser darf ausschließlich den einen veröffentlichten Ursprung ansprechen: entweder über einen Reverse-Proxy im Frontend-Container, der z.B. "/api/..." intern an den Backend-Servicenamen weiterreicht (Browser sieht nur einen relativen Pfad wie "/api/files"), oder – falls euer Frontend-Framework das nicht hergibt – über eine zur Laufzeit im Browser injizierte, tatsächlich erreichbare Adresse. Scrumys automatische Prüfung sucht seit Kurzem gezielt nach genau diesem Muster (Servicename eines nicht veröffentlichten Diensts im Code des veröffentlichten Diensts) und lässt das Ticket dafür durchfallen.
- Design-Standard, kein Vorschlag: Jedes Frontend nutzt Tailwind CSS und shadcn/ui-Komponenten statt eigener Ad-hoc-Styles – ein Projekt soll von der ersten Ansicht an wie ein vorzeigbares Produkt aussehen, nicht wie ein Rohentwurf. Dazu gehört: eine im Code festgelegte Farb- und Typografie-Skala statt verstreuter Hex-Werte oder Font-Größen, Tailwinds Spacing-Skala statt beliebiger Pixelwerte, ein durchdachter Zustand für leer/lädt/Fehler bei jeder Ansicht mit Daten (nicht nur der Erfolgsfall), und ein Layout, das auf Mobile- wie auf Desktop-Breite funktioniert. Zur Navigation gilt verbindlich: Jedes Frontend hat eine dauerhafte Seitenleiste (Sidebar) als Hauptnavigation, und zwar auch dann, wenn es zum Start nur einen einzigen Menüpunkt gibt – die Sidebar ist die Stelle, an der jeder spätere Bereich ohne Umbau dazukommt, während eine Anwendung, die mit Topbar oder ganz ohne Navigation anfängt, dafür jede Ansicht noch einmal anfassen muss. Sie zeigt den aktiven Menüpunkt sichtbar an; auf schmalen Breiten darf sie einklappen oder als Off-Canvas-Panel erscheinen, auf Desktop-Breite ist sie sichtbar. Weiche davon nur ab, wenn Konzept, Anforderungen oder ein Beschluss des Auftraggebers ausdrücklich ein anderes UI-Kit verlangen, oder bestehender, importierter Code schon eines mitbringt.
- Test-Standard, kein Vorschlag: Backend und, wo das Framework es hergibt, Frontend bekommen ein echtes 'test'-Skript, sobald ihr Container entsteht – das Einrichten ist Teil der normalen Arbeit, nicht ein Extra, das erst auf ausdrücklichen Wunsch passiert. Jedes Ticket mit fachlicher Logik (nicht reines Markup/Styling) ergänzt dafür mindestens einen Test für den Kernfall und, wo naheliegend, für die wichtigste Fehlerbedingung. Nur so fällt ein Regressionsfehler eurer eigenen automatischen Prüfung auf statt erst dem Auftraggeber. Trifft ein Ticket auf ein bestehendes, importiertes Projekt ganz ohne Testinfrastruktur, richtet ihr sie ein, sobald ihr den betroffenen Container ohnehin berührt – nicht als separates Vorhaben, aber auch nicht auf unbestimmte Zeit verschoben.
- Die Sandbox, in der dein "run_command" läuft, hat selbst kein Docker: "docker", "docker compose", "docker exec" & Co. schlagen dort IMMER mit "docker: not found" fehl, egal wie korrekt eure docker-compose.yml ist – das ist der Normalfall dieser Umgebung, kein Zeichen einer fehlenden oder kaputten Docker-Installation im Projekt. Behandle das nie als Blocker und eröffne dafür keine Klärung ("Docker installieren" o.ä. löst nichts, es gibt dort schlicht kein Docker zu installieren). Verifiziere stattdessen anders (Datei-Inhalt lesen, Syntax/Logik am Code prüfen, falls vorhanden ein echtes Unit-Test-Skript ohne Container) oder schließe mit "finish" ab, wenn der Code für sich genommen richtig aussieht – Scrumys eigene Vorschau/Sprint-Integrationsprüfung läuft außerhalb deiner Sandbox mit echtem Docker. Genauso: Ein fehlendes lint-Skript oder eine kaputte Lint-Konfiguration, die mit deinem Ticket nichts zu tun hat, reparierst du nicht nebenbei – ignorier den fehlgeschlagenen Aufruf und mach mit dem eigentlichen Ticket weiter. Ein fehlendes test-Skript zählt NICHT dazu: das ist jetzt Standard (siehe oben) und gehört eingerichtet, sobald dein Ticket den betroffenen Container berührt.
- Wo der Auftrag widersprüchlich oder lückenhaft ist, rate nicht: Sag es und lass entscheiden.
- Was du tust, muss für den Auftraggeber nachvollziehbar sein: begründe Entscheidungen kurz.`;

/// Kappt lange Texte fuer den Prompt, statt ein ganzes Lastenheft mitzuschicken.
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (gekürzt, ${text.length - maxChars} Zeichen mehr)`;
}

export async function buildProjectContext(
  projectId: string,
  options: { includeRepo?: boolean; includeBoard?: boolean; compact?: boolean; focus?: string; ticketId?: string } = {},
): Promise<string> {
  const { includeRepo = true, includeBoard = true, compact = false, focus = "", ticketId } = options;
  const focusTerms = focus.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((term) => term.length >= 4);

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

  // Der letzte Sprint ist der Stichtag dafuer, was "neu" ist: Anforderungen,
  // die danach dazukamen, hat noch keine Planung gesehen. Ohne diese Markierung
  // liest der Product Owner eine Liste, die er groesstenteils laengst umgesetzt
  // hat, und meldet den Backlog als leer – die nachgereichte Ausbaustufe des
  // Auftraggebers faellt dabei durch.
  const latestSprint = await prisma.sprint.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
  });

  // Das Beschlussregister: Was der Auftraggeber in Klaerungen entschieden hat,
  // gehoert in JEDEN Prompt. Ohne das laeuft das Team in vier Wochen in
  // dieselbe Frage – und entscheidet sie dann womoeglich anders als er.
  const [decisions, openClarifications] = await Promise.all([
    prisma.clarification.findMany({
      where: { projectId, status: "DECIDED" },
      orderBy: { decidedAt: "desc" },
      // Im Compact-Modus wird unten nach Ticket-Bezug gefiltert (siehe
      // relevantDecisions) – dafuer braucht es einen groesseren Kandidatenpool
      // als die 6, die am Ende tatsaechlich in den Prompt kommen, sonst faellt
      // ein aelterer, aber fuer GENAU DIESES Ticket relevanter Beschluss schon
      // hier raus.
      take: compact ? 40 : 20,
      include: { ticket: { select: { title: true } } },
    }),
    prisma.clarification.findMany({
      where: { projectId, status: "OPEN" },
      orderBy: { createdAt: "asc" },
      ...(compact ? { take: 10 } : {}),
      include: { ticket: { select: { title: true } } },
    }),
  ]);

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
  const isNew = (createdAt: Date) => Boolean(latestSprint) && createdAt > latestSprint!.startedAt;
  const newRequirementCount = project.requirements.filter((requirement) => isNew(requirement.createdAt)).length;
  const requirements = orderedRequirements
    .map((requirement, index) => {
      const marker = isNew(requirement.createdAt) ? `[NEU seit Sprint ${latestSprint!.number}] ` : "";
      const head = `${index + 1}. ${marker}[${PRIORITY_LABEL[requirement.priority]}] ${requirement.title}`;
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
  parts.push(
    `# Freigegebene Anforderungen\n${requirements || "(keine erfasst)"}` +
      (newRequirementCount > 0
        ? `\n\n${newRequirementCount} mit [NEU seit Sprint ${latestSprint!.number}] markierte Anforderung${newRequirementCount === 1 ? " kam" : "en kamen"} erst nach Beginn des letzten Sprints dazu – ` +
          `sie ${newRequirementCount === 1 ? "wurde" : "wurden"} noch von keiner Planung berücksichtigt und ${newRequirementCount === 1 ? "ist" : "sind"} offene Arbeit.`
        : ""),
  );

  // Im Compact-Modus geht es nicht um das ganze Beschlussregister, sondern um
  // das, was FUER DIESES TICKET gilt: sein eigener Verlauf (immer, egal wie
  // alt) sowie Beschluesse, deren Frage inhaltlich zum Ticket passt. Sonst
  // schleppt jeder Ticket-Prompt projektweit die zuletzt getroffenen
  // Beschluesse mit, auch wenn sie ein ganz anderes Ticket betreffen.
  const relevantDecisions = compact && focusTerms.length > 0
    ? [...decisions]
        .sort((a, b) => {
          const score = (entry: (typeof decisions)[number]) => {
            if (ticketId && entry.ticketId === ticketId) return 1000;
            const text = `${entry.ticket?.title ?? ""} ${entry.question} ${entry.decision ?? ""}`.toLowerCase();
            return focusTerms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
          };
          return score(b) - score(a);
        })
        .slice(0, 6)
        // Danach wieder chronologisch (aeltester zuerst) fuer die Erzaehlung
        // im Prompt – die Relevanz entschied nur, WELCHE reinkommen.
        .sort((a, b) => (a.decidedAt ?? a.createdAt).getTime() - (b.decidedAt ?? b.createdAt).getTime())
    : [...decisions].reverse();

  if (relevantDecisions.length > 0) {
    const register = relevantDecisions
      .map((entry) => {
        const when = (entry.decidedAt ?? entry.createdAt).toLocaleDateString("de-DE");
        const subject = entry.ticket ? ` (Ticket „${entry.ticket.title}")` : "";
        return `- ${when}${subject}\n  Frage: ${clip(entry.question, 400)}\n  Beschluss: ${clip(entry.decision ?? "", 800)}`;
      })
      .join("\n");
    parts.push(
      `# Beschlüsse des Auftraggebers\nDiese Entscheidungen sind getroffen und gelten. Halte dich daran, auch wenn du es anders lösen würdest. Prüfe bei jedem, ob der aktuelle Code ihn schon umsetzt – wenn nicht, ist er offene Arbeit für dich, kein erledigter Fakt.\n${register}`,
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
    const sprint = latestSprint;
    const tickets = await prisma.ticket.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { assignee: true, sprint: true },
    });

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
