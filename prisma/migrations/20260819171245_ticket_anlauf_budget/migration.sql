-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "attemptBudget" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "attemptLog" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
