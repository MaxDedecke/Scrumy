-- CreateEnum
CREATE TYPE "ClarificationScope" AS ENUM ('TICKET', 'SPRINT', 'PROJECT');

-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('OPEN', 'DECIDED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sprintBudget" INTEGER NOT NULL DEFAULT 12;

-- CreateTable
CREATE TABLE "clarifications" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ticketId" TEXT,
    "sprintId" TEXT,
    "raisedById" TEXT,
    "scope" "ClarificationScope" NOT NULL DEFAULT 'TICKET',
    "trigger" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" TEXT,
    "options" JSONB,
    "agenda" TEXT,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'OPEN',
    "decision" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resumeTask" TEXT,
    "resumePayload" JSONB,
    "forwardedAt" TIMESTAMP(3),
    "forwardedRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clarifications_forwardedRequestId_key" ON "clarifications"("forwardedRequestId");

-- CreateIndex
CREATE INDEX "clarifications_projectId_status_idx" ON "clarifications"("projectId", "status");

-- AddForeignKey
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "sprints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_forwardedRequestId_fkey" FOREIGN KEY ("forwardedRequestId") REFERENCES "support_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
