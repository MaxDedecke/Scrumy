-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "workMode" "WorkMode" NOT NULL DEFAULT 'SEQUENTIAL';
