-- SHIFT HANDOVER V1 — table ownership transfer audit trail.
--
-- Fully additive/backward-compatible: ONE new enum, ONE new table, no
-- existing table/column is altered, dropped, or renamed. No existing row
-- changes. Order.openedBy (the sole existing ownership field) is updated
-- by application code at transfer time — this migration does not touch it.
--
-- Same convention as order_item_transfers (see
-- 20260901120000_split_bill_and_item_transfer/migration.sql): a dedicated,
-- indexed table rather than only a generic AuditLog JSON entry, so the
-- Handover Overview screen can query "which tables are already transferred,
-- by whom" without parsing JSON payloads. AuditLog entries are still
-- written in parallel by application code (same pattern as
-- transfer-service.ts), for restaurant-wide audit visibility.

-- CreateEnum
CREATE TYPE "TableOwnershipTransferReason" AS ENUM ('SHIFT_HANDOVER', 'MANUAL_TABLE_TRANSFER', 'MANAGER_FORCED_TRANSFER');

-- CreateTable
CREATE TABLE "table_ownership_transfers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "tableLabel" TEXT NOT NULL,
    "previousOwnerId" TEXT NOT NULL,
    "previousOwnerName" TEXT NOT NULL,
    "newOwnerId" TEXT NOT NULL,
    "newOwnerName" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "initiatedByRole" TEXT NOT NULL,
    "acceptedBy" TEXT,
    "reason" "TableOwnershipTransferReason" NOT NULL,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_ownership_transfers_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "table_ownership_transfers" ADD CONSTRAINT "table_ownership_transfers_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "table_ownership_transfers_restaurantId_idx" ON "table_ownership_transfers"("restaurantId");

-- CreateIndex
CREATE INDEX "table_ownership_transfers_locationId_idx" ON "table_ownership_transfers"("locationId");

-- CreateIndex
CREATE INDEX "table_ownership_transfers_orderId_idx" ON "table_ownership_transfers"("orderId");

-- CreateIndex
CREATE INDEX "table_ownership_transfers_tableId_idx" ON "table_ownership_transfers"("tableId");

-- CreateIndex
CREATE INDEX "table_ownership_transfers_transferredAt_idx" ON "table_ownership_transfers"("transferredAt");
