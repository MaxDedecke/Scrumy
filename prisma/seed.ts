import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // --- Globale LLM-Profile (beratungsweit, nicht pro Kunde) --------------------
  const [sonnetProfile, opusProfile, localOllamaProfile] = await Promise.all([
    prisma.llmProfile.create({
      data: {
        name: "Claude Sonnet 5 (Cloud)",
        provider: "ANTHROPIC",
        model: "claude-sonnet-5",
        isDefault: true,
      },
    }),
    prisma.llmProfile.create({
      data: {
        name: "Claude Opus 5 (Cloud, kritische Aufgaben)",
        provider: "ANTHROPIC",
        model: "claude-opus-5",
      },
    }),
    prisma.llmProfile.create({
      data: {
        name: "Lokaler Ollama-Container",
        provider: "OLLAMA",
        model: "llama3.1:70b",
        baseUrl: "http://ollama:11434",
      },
    }),
  ]);

  const org = await prisma.organization.create({
    data: {
      name: "Demo GmbH",
      industry: "Großhandel",
    },
  });

  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Warenwirtschaft & CRM",
      description:
        "Maßgeschneidertes Warenwirtschafts-, CRM- und Auftragstool als Alternative zu SAP Business One / Odoo.",
      repoUrl: "https://github.com/MaxDedecke/demo-gmbh-erp.git",
    },
  });

  // --- Connectoren ---------------------------------------------------------------
  // Kundenweit: der Kunde meldet Anfragen über sein eigenes Jira-Projekt.
  const jiraConnector = await prisma.connector.create({
    data: {
      organizationId: org.id,
      provider: "JIRA",
      name: "Demo GmbH Jira",
      config: { baseUrl: "https://demo-gmbh.atlassian.net", projectKey: "DEMO" },
      credentialRef: "vault://demo-gmbh/jira-api-token",
    },
  });

  // Projektspezifisch: das Repo, in dem die Coding-Agenten committen.
  const gitConnector = await prisma.connector.create({
    data: {
      organizationId: org.id,
      projectId: project.id,
      provider: "GIT",
      name: "Demo GmbH ERP Repo",
      config: { repoUrl: project.repoUrl, defaultBranch: "main" },
      credentialRef: "vault://demo-gmbh/erp-repo-deploy-key",
    },
  });

  // --- Pipeline-Agenten: Support -> Product Owner -> Planning -> Coding-Agenten --
  const [support, productOwner, planning, backend, frontend, reviewer] = await Promise.all([
    prisma.agent.create({
      data: { name: "Support-Agent", role: "SUPPORT", llmProfileId: sonnetProfile.id, status: "WORKING" },
    }),
    prisma.agent.create({
      data: { name: "Product-Owner-Agent", role: "PRODUCT_OWNER", llmProfileId: sonnetProfile.id, status: "WORKING" },
    }),
    prisma.agent.create({
      data: { name: "Planning-Agent", role: "PLANNING", llmProfileId: opusProfile.id, status: "IDLE" },
    }),
    prisma.agent.create({
      data: { name: "Backend-Agent", role: "BACKEND", llmProfileId: sonnetProfile.id, status: "WORKING" },
    }),
    prisma.agent.create({
      data: { name: "Frontend-Agent", role: "FRONTEND", llmProfileId: localOllamaProfile.id, status: "IDLE" },
    }),
    prisma.agent.create({
      data: { name: "Reviewer-Agent", role: "REVIEWER", llmProfileId: opusProfile.id, status: "IDLE" },
    }),
  ]);

  // Agent-Einsätze im Projekt, jeweils mit dem passenden Connector.
  await prisma.agentAssignment.createMany({
    data: [
      { agentId: support.id, projectId: project.id, connectorId: jiraConnector.id },
      { agentId: productOwner.id, projectId: project.id },
      { agentId: planning.id, projectId: project.id },
      { agentId: backend.id, projectId: project.id, connectorId: gitConnector.id },
      { agentId: frontend.id, projectId: project.id, connectorId: gitConnector.id },
      { agentId: reviewer.id, projectId: project.id },
    ],
  });

  // --- Kundenanfragen: eine bereits in ein Ticket überführt, eine noch offen -----
  const requestPdfBug = await prisma.supportRequest.create({
    data: {
      organizationId: org.id,
      connectorId: jiraConnector.id,
      channel: "JIRA",
      externalRef: "DEMO-142",
      fromContact: "buchhaltung@demo-gmbh.example",
      subject: "Rechnungs-PDF kaputt bei Sammelrechnungen",
      body: "Bei mehr als 20 Positionen bricht das PDF-Layout um und Summen stimmen nicht mehr.",
      status: "CONVERTED",
      handledById: support.id,
    },
  });

  const requestMindestbestand = await prisma.supportRequest.create({
    data: {
      organizationId: org.id,
      connectorId: jiraConnector.id,
      channel: "EMAIL",
      fromContact: "lager@demo-gmbh.example",
      subject: "Warnung bei Mindestbestand?",
      body: "Könnt ihr uns benachrichtigen, wenn ein Artikel unter den Mindestbestand fällt? Kommt aktuell öfter vor, dass wir das zu spät merken.",
      status: "NEW",
    },
  });

  const ticketBacklog = await prisma.ticket.create({
    data: {
      projectId: project.id,
      sourceRequestId: requestMindestbestand.id,
      title: "Lagerbestand: Mindestbestand-Warnung",
      description:
        "Automatische Benachrichtigung, wenn ein Artikel unter den definierten Mindestbestand fällt.",
      type: "FEATURE",
      status: "BACKLOG",
      priority: "MEDIUM",
      requestedBy: "Lagerleitung Demo GmbH",
    },
  });

  const ticketInProgress = await prisma.ticket.create({
    data: {
      projectId: project.id,
      title: "CRM: Kontakt-Import aus CSV",
      description: "Bestandskunden aus dem alten System per CSV-Upload importieren.",
      plan:
        "1) CSV-Parser mit Spalten-Mapping-UI, 2) Validierung (Pflichtfelder, Duplikate), " +
        "3) Dry-Run-Vorschau vor dem Import, 4) Import + Aktivitäts-Log-Eintrag pro Batch.",
      type: "FEATURE",
      status: "IN_PROGRESS",
      priority: "HIGH",
      requestedBy: "Vertrieb Demo GmbH",
    },
  });

  const ticketInReview = await prisma.ticket.create({
    data: {
      projectId: project.id,
      sourceRequestId: requestPdfBug.id,
      title: "Auftrag: Rechnungs-PDF-Layout kaputt bei Sammelrechnungen",
      description: "Bei mehr als 20 Positionen bricht das PDF-Layout um und Summen stimmen nicht.",
      plan: "PDF-Renderer auf Pagination pro 15 Positionen umstellen, Summenzeile pro Seite neu berechnen.",
      type: "BUG",
      status: "IN_REVIEW",
      priority: "URGENT",
      requestedBy: "Buchhaltung Demo GmbH",
      isCritical: true,
      externalRef: "DEMO-142",
    },
  });

  const ticketDone = await prisma.ticket.create({
    data: {
      projectId: project.id,
      title: "Integration: DATEV-Export für Buchhaltung",
      description: "Monatlicher Export der Belege im DATEV-Format.",
      type: "INTEGRATION",
      status: "DONE",
      priority: "HIGH",
      requestedBy: "Buchhaltung Demo GmbH",
    },
  });

  await prisma.reviewApproval.create({
    data: {
      ticketId: ticketInReview.id,
      reviewerName: "Max Dedecke",
      decision: "PENDING",
      comment: "Kritische Änderung an der Rechnungsstellung – wartet auf menschliche Freigabe.",
    },
  });

  await prisma.activityLogEntry.createMany({
    data: [
      {
        supportRequestId: requestPdfBug.id,
        agentId: support.id,
        actor: support.name,
        action: "request_received",
        detail: "Bug-Report aus Jira (DEMO-142) empfangen und triagiert.",
      },
      {
        ticketId: ticketInReview.id,
        supportRequestId: requestPdfBug.id,
        agentId: productOwner.id,
        actor: productOwner.name,
        action: "ticket_created",
        detail: "Aus DEMO-142 Ticket erstellt, als kritisch markiert und priorisiert (URGENT).",
      },
      {
        ticketId: ticketInReview.id,
        agentId: planning.id,
        actor: planning.name,
        action: "plan_created",
        detail: "Umsetzungsplan im Ticket hinterlegt.",
      },
      {
        ticketId: ticketInReview.id,
        agentId: backend.id,
        actor: backend.name,
        action: "code_committed",
        detail: "Fix für PDF-Layout gepusht, wartet auf Review durch Reviewer-Agent + Mensch.",
      },
      {
        ticketId: ticketInReview.id,
        agentId: reviewer.id,
        actor: reviewer.name,
        action: "review_requested",
        detail: "Als kritische Änderung markiert, menschliches Review angefordert.",
      },
      {
        supportRequestId: requestMindestbestand.id,
        agentId: support.id,
        actor: support.name,
        action: "request_received",
        detail: "Feature-Wunsch per E-Mail empfangen, wartet auf Triage.",
      },
      {
        ticketId: ticketBacklog.id,
        agentId: productOwner.id,
        actor: productOwner.name,
        action: "ticket_created",
        detail: "Aus Kunden-E-Mail ins Backlog aufgenommen (MEDIUM).",
      },
      {
        ticketId: ticketInProgress.id,
        agentId: backend.id,
        actor: backend.name,
        action: "status_changed",
        detail: "BACKLOG -> IN_PROGRESS: CSV-Parser implementiert.",
      },
      {
        ticketId: ticketDone.id,
        agentId: backend.id,
        actor: backend.name,
        action: "status_changed",
        detail: "IN_REVIEW -> DONE: DATEV-Export deployt.",
      },
    ],
  });

  console.log(`Seed abgeschlossen für Organisation "${org.name}" / Projekt "${project.name}".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
