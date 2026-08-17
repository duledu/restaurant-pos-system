-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH');

-- CreateEnum
CREATE TYPE "VoidReasonCode" AS ENUM ('ORDERED_BY_MISTAKE', 'WRONG_QUANTITY', 'CUSTOMER_CHANGED_MIND', 'WRONG_ITEM', 'KITCHEN_UNAVAILABLE', 'KITCHEN_ISSUE', 'QUALITY_ISSUE', 'MANAGER_DECISION', 'OTHER');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "category" TEXT,
ADD COLUMN     "isSuspicious" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO';

-- CreateTable
CREATE TABLE "order_item_voids" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "tableLabel" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "quantityBefore" INTEGER NOT NULL,
    "voidedQuantity" INTEGER NOT NULL,
    "quantityAfter" INTEGER NOT NULL,
    "voidedValue" DECIMAL(12,2) NOT NULL,
    "reasonCode" "VoidReasonCode" NOT NULL,
    "explanation" TEXT NOT NULL,
    "voidedBy" TEXT NOT NULL,
    "voidedByRole" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_voids_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_voids_restaurantId_idx" ON "order_item_voids"("restaurantId");

-- CreateIndex
CREATE INDEX "order_item_voids_locationId_idx" ON "order_item_voids"("locationId");

-- CreateIndex
CREATE INDEX "order_item_voids_orderId_idx" ON "order_item_voids"("orderId");

-- CreateIndex
CREATE INDEX "order_item_voids_orderItemId_idx" ON "order_item_voids"("orderItemId");

-- CreateIndex
CREATE INDEX "order_item_voids_shiftId_idx" ON "order_item_voids"("shiftId");

-- CreateIndex
CREATE INDEX "order_item_voids_voidedBy_idx" ON "order_item_voids"("voidedBy");

-- CreateIndex
CREATE INDEX "order_item_voids_voidedAt_idx" ON "order_item_voids"("voidedAt");

-- CreateIndex
CREATE INDEX "audit_logs_restaurantId_isSuspicious_idx" ON "audit_logs"("restaurantId", "isSuspicious");

-- CreateIndex
CREATE INDEX "audit_logs_restaurantId_category_idx" ON "audit_logs"("restaurantId", "category");

-- AddForeignKey
ALTER TABLE "order_item_voids" ADD CONSTRAINT "order_item_voids_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_voids" ADD CONSTRAINT "order_item_voids_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_voids" ADD CONSTRAINT "order_item_voids_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

