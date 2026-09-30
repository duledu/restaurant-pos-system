-- CreateEnum
CREATE TYPE "GuestOrderHandoffStatus" AS ENUM ('PENDING', 'CLAIMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "guest_order_handoffs" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "GuestOrderHandoffStatus" NOT NULL DEFAULT 'PENDING',
    "itemCount" INTEGER NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedByEmployeeId" TEXT,
    "claimedTableId" TEXT,

    CONSTRAINT "guest_order_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_order_handoff_items" (
    "id" TEXT NOT NULL,
    "handoffId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "priceSnapshot" DECIMAL(12,2) NOT NULL,
    "preparationStation" "PreparationStation" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guest_order_handoff_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_order_handoffs_tokenHash_key" ON "guest_order_handoffs"("tokenHash");

-- CreateIndex
CREATE INDEX "guest_order_handoffs_restaurantId_idx" ON "guest_order_handoffs"("restaurantId");

-- CreateIndex
CREATE INDEX "guest_order_handoffs_status_expiresAt_idx" ON "guest_order_handoffs"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "guest_order_handoff_items_handoffId_idx" ON "guest_order_handoff_items"("handoffId");

-- AddForeignKey
ALTER TABLE "guest_order_handoffs" ADD CONSTRAINT "guest_order_handoffs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_order_handoff_items" ADD CONSTRAINT "guest_order_handoff_items_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "guest_order_handoffs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
