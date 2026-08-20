-- CreateEnum
CREATE TYPE "LiveTrigger" AS ENUM ('MANUAL', 'SPRINT_REVIEW');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "liveError" TEXT,
ADD COLUMN     "liveKeepData" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "livePort" INTEGER,
ADD COLUMN     "liveService" TEXT,
ADD COLUMN     "liveStartedAt" TIMESTAMP(3),
ADD COLUMN     "liveStatus" "PreviewStatus" NOT NULL DEFAULT 'STOPPED',
ADD COLUMN     "liveTrigger" "LiveTrigger";
