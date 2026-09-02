-- P1.2: Automatsko skidanje sirovina po normativu — dodaje paymentId/orderId
-- referencu na IngredientMovement (za SALE tip: idempotency + izveštavanje),
-- isti obrazac kao postojeći InventoryMovement.paymentId/orderId.
--
-- Ova migracija je RUČNO sastavljena iz `prisma migrate diff` izlaza — SADRŽI
-- SAMO tri stvarno nove izjave ispod. NAMERNO ISKLJUČUJE (nisu deo ove
-- migracije) sledeće izjave koje se pojavljuju u sirovom diff izlazu zbog
-- postojeće drift-e nepovezane sa ovom izmenom:
--   - DROP INDEX "inventory_items_locationId_idx"
--   - ALTER TABLE "inventory_items"/"modifier_groups"/"modifier_options"
--     ALTER COLUMN "updatedAt" DROP DEFAULT
--   - DROP TABLE "_rcs_database_environment" (marker tabela namerno NIJE
--     deo Prisma šeme — vidi scripts/lib/db-environment.mjs)
--   - CREATE UNIQUE INDEX "inventory_movements_paymentId_menuItemId_key"
--     (već postoji na bazi kao ranija, pre-schema drift; nepovezano sa ovom
--     izmenom, namerno se ne dira ovde)

-- AlterTable
ALTER TABLE "ingredient_movements" ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "paymentId" TEXT;

-- CreateIndex
CREATE INDEX "ingredient_movements_paymentId_idx" ON "ingredient_movements"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_movements_paymentId_ingredientId_key" ON "ingredient_movements"("paymentId", "ingredientId");
