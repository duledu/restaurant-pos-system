-- CreateEnum
CREATE TYPE "PrintJobType" AS ENUM ('KITCHEN', 'BAR', 'RECEIPT');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'PRINTING', 'PRINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PrinterType" AS ENUM ('BROWSER', 'ESC_POS_LAN', 'NETWORK');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discountAmount" DECIMAL(12,2),
ADD COLUMN     "discountReason" TEXT;

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "discountAmount" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "PrintJobType" NOT NULL,
    "station" "ProductionStation",
    "dispatchKey" TEXT NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "isReprint" BOOLEAN NOT NULL DEFAULT false,
    "reprintOfId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_settings" (
    "restaurantId" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "taxIdNumber" TEXT,
    "receiptFooterText" TEXT,
    "receiptLegalNote" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("restaurantId")
);

-- CreateTable
CREATE TABLE "printer_configs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "station" "PrintJobType" NOT NULL,
    "name" TEXT NOT NULL,
    "printerType" "PrinterType" NOT NULL DEFAULT 'BROWSER',
    "paperWidthMm" INTEGER NOT NULL DEFAULT 80,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoPrint" BOOLEAN NOT NULL DEFAULT false,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "ipAddress" TEXT,
    "port" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "printer_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_jobs_restaurantId_idx" ON "print_jobs"("restaurantId");

-- CreateIndex
CREATE INDEX "print_jobs_locationId_idx" ON "print_jobs"("locationId");

-- CreateIndex
CREATE INDEX "print_jobs_orderId_idx" ON "print_jobs"("orderId");

-- CreateIndex
CREATE INDEX "print_jobs_status_idx" ON "print_jobs"("status");

-- CreateIndex
CREATE INDEX "print_jobs_createdAt_idx" ON "print_jobs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "print_jobs_orderId_dispatchKey_key" ON "print_jobs"("orderId", "dispatchKey");

-- CreateIndex
CREATE INDEX "printer_configs_restaurantId_idx" ON "printer_configs"("restaurantId");

-- CreateIndex
CREATE INDEX "printer_configs_locationId_idx" ON "printer_configs"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "printer_configs_locationId_station_key" ON "printer_configs"("locationId", "station");

-- CreateIndex
CREATE INDEX "order_item_voids_restaurantId_locationId_voidedAt_idx" ON "order_item_voids"("restaurantId", "locationId", "voidedAt");

-- CreateIndex
CREATE INDEX "payments_restaurantId_locationId_completedAt_idx" ON "payments"("restaurantId", "locationId", "completedAt");

-- CreateIndex
CREATE INDEX "shifts_restaurantId_locationId_openedAt_idx" ON "shifts"("restaurantId", "locationId", "openedAt");

-- CreateIndex
CREATE INDEX "shifts_restaurantId_locationId_closedAt_idx" ON "shifts"("restaurantId", "locationId", "closedAt");

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_reprintOfId_fkey" FOREIGN KEY ("reprintOfId") REFERENCES "print_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
