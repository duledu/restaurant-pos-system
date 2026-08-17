-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "locationId" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_restaurantId_locationId_idx" ON "audit_logs"("restaurantId", "locationId");

