-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "requirementsApprovedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "concept_versions" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "concept_versions_conceptId_version_key" ON "concept_versions"("conceptId", "version");

-- AddForeignKey
ALTER TABLE "concept_versions" ADD CONSTRAINT "concept_versions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
