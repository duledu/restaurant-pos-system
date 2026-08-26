-- P1.5: Dedicated hierarchical INVENTORY category system (InventoryCategory)
-- — deliberately SEPARATE from MenuCategory (which organizes what's SOLD).
-- KUHINJA/ŠANK -> subcategory, restaurant-scoped, self-referencing.
-- Assignable to BOTH Ingredient (raw materials) and MenuItem (direct-stock
-- resale items, e.g. Coca-Cola -> ŠANK -> Sokovi) — never affects
-- naplata/odbitak, purely an organizational/UX field.
--
-- This migration is RUČNO sastavljena iz `prisma migrate diff` izlaza —
-- SADRŽI SAMO stvarno nove izjave ispod. NAMERNO ISKLJUČUJE (nisu deo ove
-- migracije) sledeće izjave iz sirovog diff izlaza zbog postojeće drift-e
-- nepovezane sa ovom izmenom (isti obrazac kao svaka ranija migracija ove
-- sesije):
--   - svi DROP/ADD FOREIGN KEY parovi za tabele nepovezane sa ovom izmenom
--     (devices, employees, floors, locations, menu_categories, orders,
--     order_items, order_item_stations, order_events, restaurant_tables,
--     restaurants, role_permissions, roles, shifts, i postojeći
--     menu_items_restaurantId_fkey/menu_items_categoryId_fkey) — Prisma
--     samo ponovo normalizuje već postojeće FK definicije, čist šum
--   - DROP INDEX "inventory_items_locationId_idx"
--   - ALTER TABLE "inventory_items"/"modifier_groups"/"modifier_options"
--     ALTER COLUMN "updatedAt" DROP DEFAULT
--   - DROP TABLE "_rcs_database_environment" / "_rcs_test_database_marker"
--     (marker tabele namerno NISU deo Prisma šeme)
--   - CREATE UNIQUE INDEX "inventory_movements_paymentId_menuItemId_key"
--     (već postoji na bazi kao ranija, pre-schema drift; nepovezano sa ovom
--     izmenom, namerno se ne dira ovde)

-- CreateTable
CREATE TABLE "inventory_categories" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "inventoryCategoryId" TEXT;

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "inventoryCategoryId" TEXT;

-- CreateIndex
CREATE INDEX "inventory_categories_restaurantId_idx" ON "inventory_categories"("restaurantId");

-- CreateIndex
CREATE INDEX "inventory_categories_restaurantId_isActive_idx" ON "inventory_categories"("restaurantId", "isActive");

-- CreateIndex
CREATE INDEX "inventory_categories_parentId_idx" ON "inventory_categories"("parentId");

-- CreateIndex
CREATE INDEX "ingredients_inventoryCategoryId_idx" ON "ingredients"("inventoryCategoryId");

-- CreateIndex
CREATE INDEX "menu_items_inventoryCategoryId_idx" ON "menu_items"("inventoryCategoryId");

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "inventory_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_inventoryCategoryId_fkey" FOREIGN KEY ("inventoryCategoryId") REFERENCES "inventory_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_inventoryCategoryId_fkey" FOREIGN KEY ("inventoryCategoryId") REFERENCES "inventory_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
