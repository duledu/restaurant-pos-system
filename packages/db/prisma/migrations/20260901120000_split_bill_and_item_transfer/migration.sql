-- FAZA 8 — Split Bill (delimično plaćanje porudžbine) i Transfer stavki
-- između stolova. RUČNO sastavljena migracija (isti obrazac kao svaka
-- ranija migracija ove sesije).
--
-- SPLIT BILL:
--   1. order_items.paidQuantity — koliko je od quantity već naplaćeno
--      (novi red, default 0 — postojeće stavke ostaju netaknute).
--   2. payments.orderId @unique je UKLONJEN — bio je najavljen kao
--      MVP-only ograničenje ("Split plaćanje kasnije zahteva uklanjanje
--      ovog unique-a i uvođenje PaymentAllocation") još od Faze 2. Zamenjen
--      sa @@unique([orderId, idempotencyKey]) — Postgres dozvoljava više
--      NULL vrednosti u unique indeksu, pa stariji/ne-idempotentni pozivi
--      i dalje rade bez konflikta; novi split-bill pozivi dobijaju
--      pravu DB-nivo zaštitu od duplog slanja istog zahteva.
--   3. payments.discountAmount / payments.isSplit — vidi schema.prisma
--      napomenu uz Payment model.
--   4. payment_items — nova tabela, alokacija (koja Payment je pokrila
--      koju količinu koje OrderItem stavke).
--   5. receipts.orderId @unique je UKLONJEN — jedan Order sada može imati
--      više Receipt redova (jedan po delimičnoj naplati); receipts.paymentId
--      @unique OSTAJE (jedan račun po plaćanju, nepromenjeno).
--
-- TRANSFER STAVKI:
--   6. order_item_transfers — nova audit tabela (izvor/odredište
--      porudžbine i stavke, količina, ko/kada).
--
-- Ni jedna izmena ne briše niti menja postojeće redove/podatke.

-- ── SPLIT BILL: order_items.paidQuantity ────────────────────────────────

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "paidQuantity" INTEGER NOT NULL DEFAULT 0;

-- ── SPLIT BILL: payments ─────────────────────────────────────────────────

-- DropIndex (bilo @unique na orderId — vidi napomenu na vrhu fajla)
DROP INDEX "payments_orderId_key";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "payments" ADD COLUMN "discountAmount" DECIMAL(12,2);
ALTER TABLE "payments" ADD COLUMN "isSplit" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_idempotencyKey_key" ON "payments"("orderId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- ── SPLIT BILL: payment_items ────────────────────────────────────────────

-- CreateTable
CREATE TABLE "payment_items" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_items_paymentId_orderItemId_key" ON "payment_items"("paymentId", "orderItemId");

-- CreateIndex
CREATE INDEX "payment_items_paymentId_idx" ON "payment_items"("paymentId");

-- CreateIndex
CREATE INDEX "payment_items_orderItemId_idx" ON "payment_items"("orderItemId");

-- AddForeignKey
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SPLIT BILL: receipts ─────────────────────────────────────────────────

-- DropIndex (bilo @unique na orderId — vidi napomenu na vrhu fajla; paymentId @unique ostaje netaknut)
DROP INDEX "receipts_orderId_key";

-- CreateIndex
CREATE INDEX "receipts_orderId_idx" ON "receipts"("orderId");

-- ── TRANSFER STAVKI: order_item_transfers ────────────────────────────────

-- CreateTable
CREATE TABLE "order_item_transfers" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceOrderItemId" TEXT NOT NULL,
    "destinationOrderId" TEXT NOT NULL,
    "destinationOrderItemId" TEXT NOT NULL,
    "sourceTableLabel" TEXT NOT NULL,
    "destinationTableLabel" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "transferredBy" TEXT NOT NULL,
    "transferredByRole" TEXT NOT NULL,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_transfers_restaurantId_idx" ON "order_item_transfers"("restaurantId");

-- CreateIndex
CREATE INDEX "order_item_transfers_locationId_idx" ON "order_item_transfers"("locationId");

-- CreateIndex
CREATE INDEX "order_item_transfers_sourceOrderId_idx" ON "order_item_transfers"("sourceOrderId");

-- CreateIndex
CREATE INDEX "order_item_transfers_destinationOrderId_idx" ON "order_item_transfers"("destinationOrderId");

-- CreateIndex
CREATE INDEX "order_item_transfers_sourceOrderItemId_idx" ON "order_item_transfers"("sourceOrderItemId");

-- CreateIndex
CREATE INDEX "order_item_transfers_destinationOrderItemId_idx" ON "order_item_transfers"("destinationOrderItemId");

-- CreateIndex
CREATE INDEX "order_item_transfers_transferredAt_idx" ON "order_item_transfers"("transferredAt");

-- AddForeignKey
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_destinationOrderId_fkey" FOREIGN KEY ("destinationOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_sourceOrderItemId_fkey" FOREIGN KEY ("sourceOrderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_transfers" ADD CONSTRAINT "order_item_transfers_destinationOrderItemId_fkey" FOREIGN KEY ("destinationOrderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
