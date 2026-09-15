-- Printing Architecture V2 — decouple pairing (one computer = one Print
-- Agent identity) from print routing (which printer serves KITCHEN/BAR/
-- RECEIPT on that computer). Fully additive/backward-compatible: no column
-- is dropped, no credential is touched, no existing PrintJob/audit history
-- is touched. `workstations.station`/`configuredPrinterName`/`paperWidthMm`/
-- `printerAvailable` are deliberately KEPT (now nullable, unused by new
-- code) as a one-release-cycle rollback safety net — planned removal is a
-- separate, later migration once the real physical Agent has passed QA on
-- the new WorkstationPrintRoute model.

-- AlterTable: pairing no longer carries a station (uparivanje uspostavlja
-- samo identitet računara; ruta štampe se bira posle, u Admin panelu).
ALTER TABLE "workstation_pairings" ALTER COLUMN "station" DROP NOT NULL;

-- AlterTable: workstations.station becomes nullable/deprecated, and the
-- workstation gains a place to cache the Agent's last-reported full printer
-- list (so Admin can pick a printer from a real dropdown, not free text).
ALTER TABLE "workstations"
  ADD COLUMN "availablePrinters" JSONB,
  ADD COLUMN "printersReportedAt" TIMESTAMP(3),
  ALTER COLUMN "station" DROP NOT NULL;

-- CreateTable: one Workstation now has 0..N independent print routes
-- (KITCHEN/BAR/RECEIPT), each with its own printer + paper width. The same
-- physical printer may be reused across multiple routes (no unique
-- constraint on printerName) — only one route per (workstation, type).
CREATE TABLE "workstation_print_routes" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "workstationId" TEXT NOT NULL,
    "type" "PrintJobType" NOT NULL,
    "printerName" TEXT,
    "paperWidthMm" INTEGER,
    "printerAvailable" BOOLEAN,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstation_print_routes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workstation_print_routes_restaurantId_idx" ON "workstation_print_routes"("restaurantId");
CREATE INDEX "workstation_print_routes_locationId_idx" ON "workstation_print_routes"("locationId");
CREATE INDEX "workstation_print_routes_type_idx" ON "workstation_print_routes"("type");
CREATE UNIQUE INDEX "workstation_print_routes_workstationId_type_key" ON "workstation_print_routes"("workstationId", "type");

ALTER TABLE "workstation_print_routes"
  ADD CONSTRAINT "workstation_print_routes_workstationId_fkey"
  FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every existing Workstation's single station/printer/paper-width
-- becomes its first WorkstationPrintRoute row. This is what makes the real
-- physical "Kuhinja_new_test" machine's KITCHEN route exist and keep working
-- immediately after this migration runs — before any application code
-- deploy and before any Print Agent upgrade. ProductionStation (KITCHEN|BAR)
-- and PrintJobType (KITCHEN|BAR|RECEIPT) share label spelling for the two
-- overlapping values, so the text cast below is exact and lossless.
INSERT INTO "workstation_print_routes"
  ("id", "restaurantId", "locationId", "workstationId", "type", "printerName", "paperWidthMm", "printerAvailable", "isEnabled", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  w."restaurantId",
  w."locationId",
  w."id",
  w."station"::text::"PrintJobType",
  w."configuredPrinterName",
  w."paperWidthMm",
  w."printerAvailable",
  true,
  now(),
  now()
FROM "workstations" w
WHERE w."station" IS NOT NULL;
