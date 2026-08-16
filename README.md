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

- **Organization** – ein Kunde des Startups.
- **Project** – die Individualsoftware eines Kunden (z.B. "Warenwirtschaft & CRM"),
  verweist auf das eigentliche Kunden-Repository.
- **Agent** – ein LLM-Agent mit fester Rolle im virtuellen Team, einem Projekt
  zugeordnet.
- **Ticket** – Feature-Request/Bug/Integration auf dem Scrum-Board eines Projekts
  (`Backlog → In Arbeit → In Review → Fertig`).
- **ReviewApproval** – menschlicher Freigabe-Schritt für als kritisch markierte
  Tickets, bevor sie beim Kunden deployt werden.
- **ActivityLogEntry** – Audit-Trail, macht die Arbeit der Agenten für den Kunden
  nachvollziehbar.

Das Datenmodell liegt in [`prisma/schema.prisma`](./prisma/schema.prisma).

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

Dies ist das MVP-Skelett: Datenmodell + Board-UI, damit Kunden/Projekte/Tickets
sichtbar sind. Als Nächstes:

- Echte Agenten-Orchestrierung (Claude Agent SDK) je Ticket, die Code im
  Kunden-Repo umsetzt, statt nur Status/Log manuell zu pflegen.
- Auth & Mandantentrennung (Kunden sehen nur ihr eigenes Projekt).
- Client-Portal: Kunden reichen Feature-Requests selbst ein und geben kritische
  Änderungen frei (aktuell nur Datenmodell dafür vorhanden).
- CI/Deploy-Pipeline pro Kundenprojekt.
