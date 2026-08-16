import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
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

  const [pm, backend, frontend, reviewer] = await Promise.all([
    prisma.agent.create({
      data: { name: "PM-Agent", role: "PRODUCT_MANAGER", model: "claude-sonnet-5", status: "WORKING" },
    }),
    prisma.agent.create({
      data: { name: "Backend-Agent", role: "BACKEND", model: "claude-sonnet-5", status: "WORKING" },
    }),
    prisma.agent.create({
      data: { name: "Frontend-Agent", role: "FRONTEND", model: "claude-sonnet-5", status: "IDLE" },
    }),
    prisma.agent.create({
      data: { name: "Reviewer-Agent", role: "REVIEWER", model: "claude-opus-5", status: "IDLE" },
    }),
  ]);

  await prisma.agentAssignment.createMany({
    data: [pm, backend, frontend, reviewer].map((agent) => ({
      agentId: agent.id,
      projectId: project.id,
    })),
  });

  const ticketBacklog = await prisma.ticket.create({
    data: {
      projectId: project.id,
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
      type: "FEATURE",
      status: "IN_PROGRESS",
      priority: "HIGH",
      requestedBy: "Vertrieb Demo GmbH",
    },
  });

  const ticketInReview = await prisma.ticket.create({
    data: {
      projectId: project.id,
      title: "Auftrag: Rechnungs-PDF-Layout kaputt bei Sammelrechnungen",
      description: "Bei mehr als 20 Positionen bricht das PDF-Layout um und Summen stimmen nicht.",
      type: "BUG",
      status: "IN_REVIEW",
      priority: "URGENT",
      requestedBy: "Buchhaltung Demo GmbH",
      isCritical: true,
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
        ticketId: ticketBacklog.id,
        agentId: pm.id,
        actor: pm.name,
        action: "ticket_created",
        detail: "Anfrage aus Kunden-Feedback ins Backlog aufgenommen.",
      },
      {
        ticketId: ticketInProgress.id,
        agentId: backend.id,
        actor: backend.name,
        action: "status_changed",
        detail: "BACKLOG -> IN_PROGRESS: CSV-Parser implementiert.",
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
