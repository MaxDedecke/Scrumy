-- AlterTable
ALTER TABLE "clarifications" ADD COLUMN     "recommendedOptionKey" TEXT;

-- AlterTable
ALTER TABLE "review_approvals" ADD COLUMN     "recommendedDecision" "ReviewDecision",
ADD COLUMN     "recommendedFeedback" TEXT;
