# Scrumy

**Individualsoftware für Unternehmen, gebaut und gewartet von einem Agenten-Team –
statt teurer SAP-Business-One-/Odoo-Lizenzen oder Nischen-SaaS.**

Scrumy ist die interne Plattform des Beratungs-Startups selbst: Für jeden Kunden
läuft ein virtuelles Scrum-Team aus LLM-Agenten (Product-Manager-, Backend-,
Frontend-, QA-, Reviewer-, DevOps-Agent), das dessen Software wie ein echtes
Dienstleister-Team plant, baut, testet und dauerhaft pflegt – Feature-Requests,
Bugfixes und Integrationen werden selbstständig umgesetzt, kritische Änderungen
durchlaufen ein menschliches Review, bevor sie beim Kunden deployt werden.

Ziel: Individualsoftware für Unternehmen kostengünstig und **skalierbar** möglich
machen, ohne dass Wartung und Pflege klassisch mit der Kundenzahl mitwachsen
müssen.

## Konzept

**Team-Start:** Ein Klick auf „Team starten" (nach Freigabe von Konzept **und**
Anforderungen) setzt das Team wirklich in Bewegung – wie der erste Arbeitstag in
einer Firma:

1. **Mannschaft aufstellen** – fehlende Rollen werden mit Namen besetzt
   (`src/lib/team.ts`).
2. **Arbeitsplatz einrichten** – ein echtes lokales Git-Repository pro Projekt
   (`src/lib/workspace.ts`), Konzept und Anforderungen landen als Dateien darin.
3. **Auftrag verstehen** – der Product Owner schreibt `docs/verstaendnis.md`
   (Umfang, Annahmen, Risiken, offene Fragen) und committet es.
4. **Scrum** – Sprint-Planung (Tickets + Ziel) → je Ticket: Planung, Umsetzung
   mit Commit unter dem Namen des Agenten, QA-Review → Sprint-Review mit
   Zusammenfassung → nächster Sprint (Autopilot) oder Halt.

Kritische Tickets und Fälle, in denen QA nach zwei Anläufen nicht zufrieden ist,
gehen als `ReviewApproval` an den Menschen, statt still fertig zu werden.

**Wenn das Team nicht weiterkommt, beruft es ein.** Jede Sackgasse – ein
endgültig gescheiterter Arbeitsschritt, eine widersprüchliche Anforderung, ein
leerer Backlog, eine unbesetzte Rolle – wird zu einer `Clarification`: eine Frage
mit Entscheidungsvorlage im Team-Büro, die den unterbrochenen Job eingefroren
mit sich trägt. Der Beschluss setzt genau diesen Job wieder in Gang und landet
im Beschlussregister, das jeder Agent ab dann in jedem Prompt mitbekommt. Ein
blockiertes Ticket hält nur sich selbst auf (das Team zieht das nächste), nur
eine projektweite Klärung hält die ganze Mannschaft an. Auch die Agenten selbst
dürfen einberufen: QA über das Urteil `needs_decision`, der Umsetzer über das
Feld `KLÄRUNG` – lieber gefragt als geraten und committet.

**Pipeline (laufender Betrieb):** Kundenkorrespondenz (per Connector, z.B. Jira,
oder manuell) → **Support-Agent** triagiert → **Product-Owner-Agent** übersetzt
sie in Tickets, packt sie in den Backlog und priorisiert → **Planning-Agent**
plant ein Ticket (Feld `plan`) → **Coding-Agenten** (Backend/Frontend/QA/DevOps)
setzen um → kritische Änderungen durchlaufen ein menschliches Review, bevor sie
deployt werden.

- **Organization** – ein Kunde des Startups.
- **Project** – die Individualsoftware eines Kunden (z.B. "Warenwirtschaft & CRM"),
  verweist auf das eigentliche Kunden-Repository.
- **Connector** – Anbindung an ein externes System (Jira, andere PM-Tools,
  E-Mail-Postfach, **Git-Repo**), über das ein Agent automatisiert arbeitet – z.B.
  der Support-Agent per Jira-Connector, der Backend-/DevOps-Agent per Git-Connector
  im Projekt-Repo. Kundenweit (`projectId` leer, z.B. das eine Jira-Postfach) oder
  projektspezifisch (z.B. genau 1 Repo). `config` enthält nur nicht-geheime
  Verbindungsdaten; Zugangsdaten liegen über `credentialRef` in einem Secret-Store,
  nicht in der DB. Konfiguriert wird das je Projekt unter "Team & Konnektoren".
- **LlmProfile** – **global, nicht pro Kunde** – ein Cloud-Modell oder ein lokaler
  Ollama-Container, den Agenten zugewiesen werden. Verwaltung unter
  `/settings/llm-profiles`.
- **SupportRequest** – eine eingehende Kundenanfrage (Feature-Request, Bug,
  allgemeine Korrespondenz), landet im Support-Postfach (`/organizations/[id]/inbox`)
  und wird ggf. in ein oder mehrere Tickets überführt.
- **Agent** – ein LLM-Agent mit fester Rolle im virtuellen Team (siehe Pipeline
  oben), einem Projekt zugeordnet.
- **Ticket** – Feature-Request/Bug/Integration auf dem Scrum-Board eines Projekts
  (`Backlog → In Arbeit → In Review → Fertig`); `plan` ist das Arbeitsfeld des
  Planning-Agents, `externalRef` verweist auf das verknüpfte Ticket im
  Kunden-System (z.B. Jira-Key) für automatisierten Status-Rücklauf.
- **ReviewApproval** – menschlicher Freigabe-Schritt für als kritisch markierte
  Tickets, bevor sie beim Kunden deployt werden.
- **Sprint** – fortlaufend nummerierter Sprint mit Ziel, Tickets und
  Review-Zusammenfassung; bleibt als Historie stehen.
- **AgentRun** – **die Belegebene**: jeder Modellaufruf mit Systemprompt, Prompt,
  Antwort, Modell, Dauer und Status. Damit ist nicht nur das Ergebnis sichtbar,
  sondern auch, worauf ein Agent es gestützt hat.
- **TeamInquiry** – Rückfrage des Menschen ans Team („Wie ist der Stand?",
  „Warum habt ihr X so gebaut?") und die Antwort des Scrum-Master-Agenten, der
  dafür Sprints, Tickets, Commits und Protokoll heranzieht.
- **Clarification** – die Gegenrichtung: das Team beruft den Auftraggeber ein.
  Mit Frage, Optionen (Agenda vom Scrum Master), Reichweite (Ticket/Sprint/
  Projekt) und dem eingefrorenen Arbeitsschritt (`resumeTask`/`resumePayload`),
  der nach dem Beschluss weiterläuft. Kann über einen Connector als
  `SupportRequest` an den Kunden weitergereicht werden.
- **ActivityLogEntry** – Audit-Trail (an Ticket und/oder SupportRequest), macht
  die Arbeit der Agenten für den Kunden nachvollziehbar.

Das Datenmodell liegt in [`prisma/schema.prisma`](./prisma/schema.prisma).

## Frontend

- `/` – Kunden &amp; Projekte anlegen/bearbeiten/löschen (Dashboard).
- `/projects/[id]` – Projekt-Übersicht: Stat-Kacheln, Agenten-Team, Scrum-Board,
  Aktivität.
- `/projects/[id]/office` – **Team-Büro**: Live-Ansicht, wer gerade woran
  arbeitet, offene Klärungen mit Entscheidungsvorlage, aktueller Sprint mit
  Fortschritt, offene Freigaben, Rückfragen ans Team, Beschlussregister und das
  Protokoll. Aktualisiert sich selbst (`LiveRefresh`), Steuerung:
  Autopilot an/aus, „Nächsten Schritt anstoßen", Anhalten/Fortsetzen.
- `/projects/[id]/records` – **Nachweise**: alle Agentenläufe (bis hin zu Prompt
  und Antwort im Wortlaut) und alle Commits (mit vollständigem Diff), dazu die
  Sprint-Reviews. Für die Frage „zeigt mir, worauf ihr euch stützt".
- `/projects/[id]/team` – Team &amp; Konnektoren: Projekt-Einstellungen, Connectoren
  anlegen/verwalten (kundenweit oder projektspezifisch, z.B. Jira/Git), Agenten
  zum Projekt hinzufügen/entfernen und pro Agent LLM-Profil + Connector zuweisen.
- `/organizations/[id]/inbox` – Support-Postfach: eingehende Kundenanfragen +
  verknüpfte Tickets.
- `/settings/llm-profiles` – **global, getrennt von den Kundendaten**: LLM-Profile
  (Cloud-Anbieter oder lokaler Ollama-Container) anlegen/bearbeiten/löschen.

Mutationen laufen über Next.js Server Actions (`src/lib/actions/*`), Formulare
funktionieren ohne Client-JS (Progressive Enhancement); nur Lösch-Bestätigungen
nutzen eine kleine Client-Komponente (`src/components/ConfirmButton.tsx`).

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript + Tailwind CSS
- [Prisma](https://www.prisma.io) + PostgreSQL
- Docker Compose für lokale Entwicklung & Deployment

## Lokal starten

```bash
cp .env.example .env

# Postgres in Docker starten
docker compose up -d db

# Dependencies + Datenbank
npm install
npm run db:migrate   # legt Migrationen an & wendet sie an
npm run db:seed       # Demo-Kunde "Demo GmbH" mit Beispielprojekt/-tickets

npm run dev
# -> http://localhost:3000
```

## Mit Docker (App + DB)

```bash
docker compose up -d --build
# App läuft danach auf http://localhost:3001
# Migrationen werden beim Container-Start automatisch angewendet (siehe Dockerfile).
```

Danach einmalig seeden (falls gewünscht):

```bash
docker compose exec app npx tsx prisma/seed.ts
```

## Worker (Job-Queue)

Damit sich pro Projekt beliebig viele Agenten anlegen lassen, ohne dass Ausführung
mitwächst: Agenten-Arbeit läuft nicht in Next.js Server Actions, sondern als Job in
einer separaten, horizontal skalierbaren Queue.

- [`graphile-worker`](https://github.com/graphile/worker) – Postgres-native Queue,
  eigenes `graphile_worker`-Schema in derselben DB (kein zusätzlicher Redis-Baustein).
- `worker/` – eigener Prozess, getrennt vom `app`-Container (eigener Service in
  `docker-compose.yml`). Skaliert unabhängig über Replicas
  (`docker compose up -d --scale worker=N`), nicht über die Agentenzahl – ein
  `IDLE`-Agent kostet nichts, er ist nur eine Zeile in der DB.
- `worker/queue.ts` – `enqueueAgentJob()`; jeder Job läuft in der `queueName`
  `agent:<agentId>`, graphile-worker serialisiert das strikt pro Agent (kein
  Doppel-Run, ganz ohne manuelles Locking). `Agent.status` bleibt reines
  UI-/Beobachtungsfeld.
- `worker/llmProfileLimiter.ts` – Concurrency-Cap pro `LlmProfile`, damit mehrere
  Agenten mit demselben LLM-Profil (Cloud-Key oder lokaler Ollama-Container) den
  Provider nicht gleichzeitig fluten.
- `worker/agentRun.ts` – **jeder** Modellaufruf läuft hier durch: `AgentRun`
  anlegen, Agentenstatus setzen, Rate-Limit ziehen, Antwort/Fehler protokollieren.
- `worker/tasks/` – die Schritte des Teams: `teamKickoff`, `sprintPlanning`,
  `ticketWork` (planen → umsetzen → QA-Review), `sprintReview`, `teamInquiry`.
  Jeder Task reiht am Ende den nächsten ein (`worker/orchestration.ts`); ein
  pausiertes Projekt bricht die Kette beim nächsten Schritt ab.
- `src/lib/workspace.ts` – die Git-Schicht: Repo anlegen, Dateien schreiben
  (mit Pfadprüfung gegen Ausbrüche aus dem Projektverzeichnis), im Namen des
  Agenten committen, Log/Diff lesen. Die Repos liegen im Volume
  `scrumy_workspaces` (`WORKSPACE_ROOT`, Standard `/workspaces`), das sich `app`
  (liest) und `worker` (schreibt) teilen.
- Ein Schritt dauert Minuten. Der `worker`-Service bekommt deshalb
  `stop_grace_period: 300s`: Beim Neustart läuft der laufende Schritt zu Ende und
  der Worker gibt seine Jobs frei – sonst blieben sie bis zum Ablauf ihrer Sperre
  (graphile-worker: 4 Stunden) liegen.
- Testen: `npm run db:seed`, dann `npm run worker:dev` und im Frontend ein
  Projekt starten (im Docker-Setup läuft der Worker als eigener Service, Logs
  über `docker compose logs -f worker`).

## Roadmap

Datenmodell, CRUD-Frontend, Discovery/Konzept-Flow und die Agenten-Orchestrierung
(Team-Start → Repo → Sprints → Commits → Nachweise) stehen. Als Nächstes:

- Support-Pipeline anschließen: Der Support-Agent liest tatsächlich aus
  Connectoren (Jira-Webhook/Polling, IMAP, …) und der Product Owner zieht
  eingehende Anfragen in den laufenden Sprint-Rhythmus.
- Tests im Kundenprojekt ausführen (Build/Testlauf im Workspace) und das
  Ergebnis in den QA-Review geben, statt nur den Diff zu lesen.
- Push in ein echtes Remote (`Project.repoUrl`) statt nur lokaler Historie.
- Connector-Implementierungen (Jira-API-Client, E-Mail-Eingang) inkl. Status-
  Rücksync über `Ticket.externalRef`.
- Auth & Mandantentrennung (Kunden sehen nur ihr eigenes Projekt/Postfach).
- Client-Portal: Kunden reichen Feature-Requests selbst ein und geben kritische
  Änderungen frei (aktuell nur Datenmodell dafür vorhanden).
- CI/Deploy-Pipeline pro Kundenprojekt.
