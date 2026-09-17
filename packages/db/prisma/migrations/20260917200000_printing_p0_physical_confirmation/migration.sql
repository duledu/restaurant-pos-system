-- PRINTING P0 — operator-confirmed physical print state
--
-- GOAL: enable a real Setup wizard that gates READY on a successful
-- technical Test Print AND explicit operator-confirmed physical print
-- (Setup must never declare READY on spooler-success alone), AND allow
-- Admin UI to surface the SUBMISSION_UNKNOWN recovery surface area.
--
-- ADDITIVE ONLY. NO column rename, NO data migration, NO constraint change.
-- Every new column has a safe default; nothing about existing rows changes.
--
-- 1. WorkstationPrintRoute gains per-route "physical confirmation":
--    - physicalTestConfirmed (bool, default false) — operator pressed YES
--      in the Setup wizard's PHYSICAL TEST -> HUMAN CONFIRMATION step for
--      this exact printer + paper width combination.
--    - physicalTestConfirmedAt (timestamptz, nullable) — when they pressed YES.
--    - physicalTestConfirmedBy (text, nullable) — who pressed it (employeeId
--      from ctx). Nullable because the Setup wizard runs unauthenticated.
--
--    Combined with the EXISTING printerAvailable + isEnabled flags, the
--    Admin/Setup UI now has a single, clear readiness state for each route:
--      READY                 = isEnabled + printerName + paperWidthMm
--                              + physicalTestConfirmed == true
--      CONFIGURED_ONLY       = isEnabled + printerName + paperWidthMm
--                              but physicalTestConfirmed == false/null
--      AGENT_CANNOT_SEE      = printerAvailable == false
--      NOT_CONFIGURED        = no printerName or isEnabled == false
--    This replaces the previous "printerAvailable==true is enough" silent
--    contract — spooler-success is necessary but no longer sufficient.
--
-- 2. WorkstationPrintRoute gains a service-side visibility probe:
--    - visibleToService (bool, nullable) — explicit probe of whether the
--      Windows Print Agent SERVICE process (NT SERVICE\TableCorePrintAgent)
--      can see the configured printer, as reported by the Agent itself.
--    - visibleToServiceAt (timestamptz, nullable) — when the probe ran.
--    Default NULL = "not yet probed". When the Agent runs the visibility
--    probe on Setup or heartbeat, it sends the result back so the server
--    can detect the gap between what Setup enumerates (per-user) and what
--    the Service enumerates (per-machine).
--
-- 3. PrintJob gains explicit operator-resolution columns. These DO NOT
--    change the lifecycle; they record human reconciliation actions on a
--    job whose submission outcome was reported as SUBMISSION_UNKNOWN:
--    - operatorConfirmedPrintedAt (timestamptz, nullable) — operator
--      pressed "Yes, ticket printed" on the recovery surface.
--    - operatorConfirmedPrintedBy (text, nullable) — employeeId.
--    - operatorReprintRequestedAt (timestamptz, nullable) — operator
--      pressed "Reprint this ticket" (creates a NEW PrintJob row, not
--      mutating the original — idempotent under repeated clicks).
--    - operatorReprintRequestedBy (text, nullable) — employeeId.
--
--    Final state of a SUBMISSION_UNKNOWN PrintJob is therefore one of:
--      (a) operatorConfirmedPrintedAt != null       -> status flipped to
--          PRINTED, audited.
--      (b) operatorReprintRequestedAt != null       -> status flipped to
--          PRINTED with note "otkucan ponovo", audited; a sibling PrintJob
--          row with isReprint=true and reprintOfId points here, also
--          audited under reprint flow.
--      (c) operator did nothing                      -> status stays
--          SUBMISSION_UNKNOWN, surfaces in Admin with a clear banner.
--    Status NEVER auto-flips back to PENDING from SUBMISSION_UNKNOWN.
--    The agent poll claim query already filters status='PENDING', so no
--    code change is needed to prevent auto-reclaim; this migration is
--    the human side of that guarantee.
--
-- 4. RestaurantSettings gains the global safe-default for new columns
--    bookkeeping (none needed for settings — left untouched intentionally).

-- ─────────────────────────────────────────────────────────────────────────
-- WorkstationPrintRoute
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "workstation_print_routes"
  ADD COLUMN "physicalTestConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "workstation_print_routes"
  ADD COLUMN "physicalTestConfirmedAt" TIMESTAMPTZ;

ALTER TABLE "workstation_print_routes"
  ADD COLUMN "physicalTestConfirmedBy" TEXT;

ALTER TABLE "workstation_print_routes"
  ADD COLUMN "visibleToService" BOOLEAN;

ALTER TABLE "workstation_print_routes"
  ADD COLUMN "visibleToServiceAt" TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────
-- PrintJob
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "print_jobs"
  ADD COLUMN "operatorConfirmedPrintedAt" TIMESTAMPTZ;

ALTER TABLE "print_jobs"
  ADD COLUMN "operatorConfirmedPrintedBy" TEXT;

ALTER TABLE "print_jobs"
  ADD COLUMN "operatorReprintRequestedAt" TIMESTAMPTZ;

ALTER TABLE "print_jobs"
  ADD COLUMN "operatorReprintRequestedBy" TEXT;

-- Index supports the Admin "PrintJobs in SUBMISSION_UNKNOWN awaiting
-- operator decision" panel query (location + status + createdAt).
CREATE INDEX "print_jobs_awaiting_operator_resolution_idx"
  ON "print_jobs" ("restaurantId", "locationId", "status", "createdAt")
  WHERE "status" = 'SUBMISSION_UNKNOWN';
