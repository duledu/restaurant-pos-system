-- PROMOTIONS & PRICING ENGINE V1 — Happy Hour i slične vremenski zakazane
-- promocije. RUČNO sastavljena migracija (isti obrazac kao svaka ranija
-- migracija ove sesije). Potpuno ADITIVNA — ne menja niti briše nijedan
-- postojeći red/kolonu/tabelu.
--
--   1. promotions — nova tabela (pravilo: naziv, tip, vrednost, schedule,
--      opcioni datumski period, opcioni locationId, priority, meko
--      arhiviranje).
--   2. promotion_targets — nova tabela (koji MenuItem/MenuCategory je
--      target-ovan, jedan red po artiklu/kategoriji).
--   3. order_items — 5 novih NULLABLE kolona (regularPrice, promotionId,
--      promotionName, promotionType, promotionValue) — istorijski
--      pricing/promotion snapshot. Postojeći redovi ostaju netaknuti (sve
--      nove kolone su NULL za njih).
--
-- Vidi schema.prisma napomenu uz model Promotion za potpuno obrazloženje.

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE_DISCOUNT', 'FIXED_PRICE');

-- CreateEnum
CREATE TYPE "PromotionTargetType" AS ENUM ('MENU_ITEM', 'MENU_CATEGORY');

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "type" "PromotionType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "daysOfWeek" INTEGER[],
    "startTime" INTEGER NOT NULL,
    "endTime" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_targets" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "targetType" "PromotionTargetType" NOT NULL,
    "menuItemId" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_restaurantId_isActive_idx" ON "promotions"("restaurantId", "isActive");

-- CreateIndex
CREATE INDEX "promotions_locationId_idx" ON "promotions"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_menuItemId_key" ON "promotion_targets"("promotionId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_targets_promotionId_categoryId_key" ON "promotion_targets"("promotionId", "categoryId");

-- CreateIndex
CREATE INDEX "promotion_targets_menuItemId_idx" ON "promotion_targets"("menuItemId");

-- CreateIndex
CREATE INDEX "promotion_targets_categoryId_idx" ON "promotion_targets"("categoryId");

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── order_items: istorijski pricing/promotion snapshot ──────────────────

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN "regularPrice" DECIMAL(12,2);
ALTER TABLE "order_items" ADD COLUMN "promotionId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "promotionName" TEXT;
ALTER TABLE "order_items" ADD COLUMN "promotionType" "PromotionType";
ALTER TABLE "order_items" ADD COLUMN "promotionValue" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "order_items_promotionId_idx" ON "order_items"("promotionId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
