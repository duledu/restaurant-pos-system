-- P1: Normativi / recepture + sirovinski lager (foundation).
--
-- Purely additive: two new enums, four new tables, their indexes and
-- foreign keys. Does NOT touch MenuItem, Order, Payment, InventoryItem, or
-- InventoryMovement in any way — the existing finished-goods inventory
-- system (menu-item stock, decremented at payment) is completely untouched.
--
-- Recipes are NOT wired to sales in this migration or the code that ships
-- with it — no SALE-type IngredientMovement is ever written yet. That is an
-- explicitly separate, later, approved phase.
--
-- Hand-assembled from a `prisma migrate diff` against the live dev database,
-- with all unrelated drift (an unrelated missing index on inventory_items,
-- unrelated column-default drift on modifier_groups/modifier_options, and a
-- DROP TABLE of the _rcs_database_environment safety-marker table that only
-- exists because it was created via raw SQL, not Prisma schema) deliberately
-- excluded — none of that belongs in this feature's migration.

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('KILOGRAM', 'GRAM', 'LITER', 'MILLILITER', 'PIECE');

-- CreateEnum
CREATE TYPE "IngredientMovementType" AS ENUM ('OPENING_STOCK', 'RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'SALE', 'INVENTORY_CORRECTION', 'RETURN_TO_SUPPLIER');

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL,
    "category" TEXT,
    "sku" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_stocks" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "currentStock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "lowStockThreshold" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingredient_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_movements" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "ingredientStockId" TEXT NOT NULL,
    "type" "IngredientMovementType" NOT NULL,
    "quantityDelta" DECIMAL(12,3) NOT NULL,
    "quantityBefore" DECIMAL(12,3) NOT NULL,
    "quantityAfter" DECIMAL(12,3) NOT NULL,
    "employeeId" TEXT,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_ingredients" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingredients_restaurantId_idx" ON "ingredients"("restaurantId");

-- CreateIndex
CREATE INDEX "ingredients_restaurantId_isActive_idx" ON "ingredients"("restaurantId", "isActive");

-- CreateIndex
CREATE INDEX "ingredient_stocks_restaurantId_idx" ON "ingredient_stocks"("restaurantId");

-- CreateIndex
CREATE INDEX "ingredient_stocks_ingredientId_idx" ON "ingredient_stocks"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_stocks_locationId_ingredientId_key" ON "ingredient_stocks"("locationId", "ingredientId");

-- CreateIndex
CREATE INDEX "ingredient_movements_ingredientStockId_idx" ON "ingredient_movements"("ingredientStockId");

-- CreateIndex
CREATE INDEX "ingredient_movements_restaurantId_idx" ON "ingredient_movements"("restaurantId");

-- CreateIndex
CREATE INDEX "ingredient_movements_locationId_idx" ON "ingredient_movements"("locationId");

-- CreateIndex
CREATE INDEX "ingredient_movements_ingredientId_idx" ON "ingredient_movements"("ingredientId");

-- CreateIndex
CREATE INDEX "ingredient_movements_createdAt_idx" ON "ingredient_movements"("createdAt");

-- CreateIndex
CREATE INDEX "menu_item_ingredients_menuItemId_idx" ON "menu_item_ingredients"("menuItemId");

-- CreateIndex
CREATE INDEX "menu_item_ingredients_ingredientId_idx" ON "menu_item_ingredients"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_ingredients_menuItemId_ingredientId_key" ON "menu_item_ingredients"("menuItemId", "ingredientId");

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_stocks" ADD CONSTRAINT "ingredient_stocks_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_stocks" ADD CONSTRAINT "ingredient_stocks_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_stocks" ADD CONSTRAINT "ingredient_stocks_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_movements" ADD CONSTRAINT "ingredient_movements_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_movements" ADD CONSTRAINT "ingredient_movements_ingredientStockId_fkey" FOREIGN KEY ("ingredientStockId") REFERENCES "ingredient_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_ingredients" ADD CONSTRAINT "menu_item_ingredients_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_ingredients" ADD CONSTRAINT "menu_item_ingredients_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
