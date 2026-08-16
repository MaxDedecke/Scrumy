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

**Pipeline:** Kundenkorrespondenz (per Connector, z.B. Jira, oder manuell) →
**Support-Agent** triagiert → **Product-Owner-Agent** übersetzt sie in Tickets,
packt sie in den Backlog und priorisiert → **Planning-Agent** plant ein Ticket
(Feld `plan`) → **Coding-Agenten** (Backend/Frontend/QA/DevOps) setzen um →
kritische Änderungen durchlaufen ein menschliches Review, bevor sie deployt werden.

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
- **ActivityLogEntry** – Audit-Trail (an Ticket und/oder SupportRequest), macht
  die Arbeit der Agenten für den Kunden nachvollziehbar.

Das Datenmodell liegt in [`prisma/schema.prisma`](./prisma/schema.prisma).

## Frontend

- `/` – Kunden &amp; Projekte anlegen/bearbeiten/löschen (Dashboard).
- `/projects/[id]` – Projekt-Übersicht: Stat-Kacheln, Agenten-Team, Scrum-Board,
  Aktivität.
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

## Roadmap

Datenmodell + CRUD-Frontend (Kunden/Projekte/Team/Connectoren/LLM-Profile) stehen.
Als Nächstes:

- Echte Agenten-Orchestrierung (Claude Agent SDK) je Pipeline-Schritt: Support-Agent
  liest tatsächlich aus Connectoren (Jira-Webhook/Polling, IMAP, …), Product-Owner-
  und Planning-Agent erzeugen Tickets/Pläne automatisch, Coding-Agenten committen
  im Kunden-Repo – aktuell bildet das Datenmodell die Pipeline nur ab, Status/Log
  werden noch manuell (Seed) gepflegt.
- Connector-Implementierungen (Jira-API-Client, E-Mail-Eingang) inkl. Status-
  Rücksync über `Ticket.externalRef`.
- Auth & Mandantentrennung (Kunden sehen nur ihr eigenes Projekt/Postfach).
- Client-Portal: Kunden reichen Feature-Requests selbst ein und geben kritische
  Änderungen frei (aktuell nur Datenmodell dafür vorhanden).
- CI/Deploy-Pipeline pro Kundenprojekt.
