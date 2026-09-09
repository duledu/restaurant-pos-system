-- Additive protocol migration. Quiesce old print clients before applying.
ALTER TYPE "PrintJobStatus" ADD VALUE 'SUBMISSION_UNKNOWN';
ALTER TYPE "PrintJobStatus" ADD VALUE 'SUPPRESSED';
ALTER TABLE "print_jobs"
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "claimedBy" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "submissionStartedAt" TIMESTAMP(3),
  ADD COLUMN "resultOutcome" TEXT,
  ADD COLUMN "isAutomatic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "printer_configs" ADD COLUMN "automaticSince" TIMESTAMP(3);
UPDATE "print_jobs" SET "isAutomatic" = true
WHERE "station" IS NOT NULL AND NOT "isReprint"
  AND ("dispatchKey" LIKE 'submit:%' OR "dispatchKey" LIKE 'void:%');
-- Existing claims have no proof of pre-submission safety. Never requeue them.
UPDATE "print_jobs" SET "submissionStartedAt" = "updatedAt"
WHERE "status" = 'PRINTING';
-- New enum values are used by the next migration, after PostgreSQL commits them.
