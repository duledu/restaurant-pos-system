-- P1.6: Explicit, restaurant-configured per-MenuItem inventory tracking
-- method (NO_TRACKING / DIRECT_STOCK / RECIPE) — replaces the DYNAMIC
-- trackStock+hasRecipe-exists check as the authoritative gate for
-- deduction/availability. A single enum column structurally guarantees
-- "exactly one path" (it cannot equal both DIRECT_STOCK and RECIPE at
-- once), which the old dual-flag design could only defend against
-- dynamically. `trackStock` stays in the schema as a synced legacy mirror
-- (kept true iff method = DIRECT_STOCK by setInventoryTrackingMethod) —
-- not removed, to avoid a riskier/larger change, but no longer read by any
-- domain-layer deduction/availability decision.
--
-- Backward compatibility (critical — Development has 138 trackStock=true
-- MenuItems, 0 of which currently have any recipe line):
--   1. ADD COLUMN with default NO_TRACKING (existing rows unaffected).
--   2. Backfill DIRECT_STOCK for every row where trackStock = true — this
--      exactly preserves current real behavior for all 138 Development
--      rows (none of them have recipes), per the explicit instruction to
--      NOT silently reinterpret them as RECIPE.
--   3. Backfill RECIPE (applied LAST, so it wins) for every MenuItem that
--      currently has at least one MenuItemIngredient line — mirrors the
--      exact priority the old getMenuItemIdsWithRecipes double-deduction
--      guard already enforced ("a configured recipe always wins").
--
-- This migration is RUČNO sastavljena (nema `prisma migrate diff` šuma) —
-- isti obrazac kao svaka ranija migracija ove sesije.

-- CreateEnum
CREATE TYPE "InventoryTrackingMethod" AS ENUM ('NO_TRACKING', 'DIRECT_STOCK', 'RECIPE');

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN "inventoryTrackingMethod" "InventoryTrackingMethod" NOT NULL DEFAULT 'NO_TRACKING';

-- CreateIndex
CREATE INDEX "menu_items_inventoryTrackingMethod_idx" ON "menu_items"("inventoryTrackingMethod");

-- Backfill: preserve current DIRECT_STOCK (finished-goods) behavior exactly.
UPDATE "menu_items" SET "inventoryTrackingMethod" = 'DIRECT_STOCK' WHERE "trackStock" = true;

-- Backfill: recipe-governed items win over DIRECT_STOCK (same priority as
-- the pre-existing dynamic double-deduction defense).
UPDATE "menu_items" SET "inventoryTrackingMethod" = 'RECIPE'
WHERE "id" IN (SELECT DISTINCT "menuItemId" FROM "menu_item_ingredients");
