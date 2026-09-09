UPDATE "print_jobs" SET "status" = 'SUBMISSION_UNKNOWN',
  "resultOutcome" = 'SUBMISSION_UNKNOWN',
  "failureReason" = 'Legacy claim requires reconciliation; do not automatically retry.'
WHERE "status" = 'PRINTING' AND "attemptId" IS NULL;
UPDATE "print_jobs" j SET "status" = 'SUPPRESSED',
  "failureReason" = 'Automatic printing disabled at protocol migration.'
FROM "printer_configs" p
WHERE j."locationId" = p."locationId" AND j."restaurantId" = p."restaurantId"
  AND j."station"::text = p."station"::text
  AND j."isAutomatic" AND j."status" = 'PENDING'
  AND (NOT p."autoPrint" OR NOT p."isEnabled");
