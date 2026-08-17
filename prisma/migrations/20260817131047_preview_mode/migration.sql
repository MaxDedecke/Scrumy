-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'ERROR');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewCommand" TEXT,
ADD COLUMN     "previewDir" TEXT,
ADD COLUMN     "previewError" TEXT,
ADD COLUMN     "previewPid" INTEGER,
ADD COLUMN     "previewPort" INTEGER,
ADD COLUMN     "previewStartedAt" TIMESTAMP(3),
ADD COLUMN     "previewStatus" "PreviewStatus" NOT NULL DEFAULT 'STOPPED';
