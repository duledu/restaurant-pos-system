-- Kuhinja/Šank operativna dostupnost ("NIJE DOSTUPNO") + Inventura (fizičko
-- prebrojavanje zaliha). Potpuno aditivno — nova tabela/kolone/indeksi/enum
-- vrednosti, ništa se ne briše niti prepisuje.
--
-- RUČNO sastavljena iz `prisma migrate diff` izlaza — SADRŽI SAMO stvarno
-- nove izjave ispod. NAMERNO ISKLJUČUJE (nisu deo ove migracije) sledeće
-- izjave iz sirovog diff izlaza zbog postojeće drift-e nepovezane sa ovom
-- izmenom (isti obrazac kao svaka ranija migracija ovog projekta):
--   - svi DROP/ADD FOREIGN KEY parovi (Prisma samo ponovo normalizuje već
--     postojeće FK definicije, čist šum)
--   - DROP INDEX "inventory_items_locationId_idx" / "menu_items_inventoryTrackingMethod_idx"
--   - ALTER TABLE "inventory_items"/"modifier_groups"/"modifier_options"
--     ALTER COLUMN "updatedAt" DROP DEFAULT
--   - DROP TABLE "_rcs_test_database_marker" / "_rcs_database_environment"
--     (marker tabele namerno NISU deo Prisma šeme)
--   - CREATE UNIQUE INDEX "inventory_movements_paymentId_menuItemId_key"
--     (već postoji na bazi kao ranija, pre-schema drift; nepovezano sa ovom
--     izmenom, namerno se ne dira ovde)

-- ── ENUM-ovi ──────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "AvailabilityReasonCode" AS ENUM ('NEMA_PROIZVODA', 'NEMA_SIROVINE_FIZICKI', 'OPREMA_KVAR', 'NEMA_STRUJE_GASA', 'STANICA_NE_RADI', 'NIJE_MOGUCE_PRIPREMITI', 'DRUGO');

-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('OPEN', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "InventoryCountTargetType" AS ENUM ('INGREDIENT', 'MENU_ITEM');

-- CreateEnum
CREATE TYPE "InventoryCountLineStatus" AS ENUM ('NOT_COUNTED', 'MATCH', 'SHORTAGE', 'SURPLUS', 'STALE');

-- AlterEnum: nova vrednost za InventoryMovement.type — vidi inventura-service.ts.
-- Bezbedno unutar iste transakcije jer se NOVA vrednost ovde samo DEKLARIŠE,
-- nikad i KORISTI u istoj migraciji (Postgres ograničenje: ADD VALUE + USE
-- iste vrednosti ne sme biti u istoj transakciji — ovde to nije slučaj).
ALTER TYPE "MovementType" ADD VALUE 'INVENTORY_CORRECTION';

-- ── OPERATIVNA DOSTUPNOST ─────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "menu_item_availabilities" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "reasonCode" "AvailabilityReasonCode",
    "note" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_item_availabilities_restaurantId_idx" ON "menu_item_availabilities"("restaurantId");

-- CreateIndex
CREATE INDEX "menu_item_availabilities_menuItemId_idx" ON "menu_item_availabilities"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_availabilities_locationId_menuItemId_key" ON "menu_item_availabilities"("locationId", "menuItemId");

-- ── INVENTURA ─────────────────────────────────────────────────────────────

-- AlterTable: generička referenceType/referenceId poveznica na InventoryMovement
-- (IngredientMovement je već imao ovaj par od ranije — vidi 20260823220000).
ALTER TABLE "inventory_movements" ADD COLUMN     "referenceId" TEXT,
ADD COLUMN     "referenceType" TEXT;

-- CreateIndex
CREATE INDEX "inventory_movements_referenceType_referenceId_idx" ON "inventory_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "ingredient_movements_referenceType_referenceId_idx" ON "ingredient_movements"("referenceType", "referenceId");

-- CreateTable
CREATE TABLE "inventory_count_sessions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'OPEN',
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "inventory_count_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_count_sessions_restaurantId_idx" ON "inventory_count_sessions"("restaurantId");

-- CreateIndex
CREATE INDEX "inventory_count_sessions_locationId_idx" ON "inventory_count_sessions"("locationId");

-- CreateIndex
CREATE INDEX "inventory_count_sessions_restaurantId_locationId_status_idx" ON "inventory_count_sessions"("restaurantId", "locationId", "status");

-- CreateTable
CREATE TABLE "inventory_count_lines" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "targetType" "InventoryCountTargetType" NOT NULL,
    "ingredientId" TEXT,
    "menuItemId" TEXT,
    "systemQtySnapshot" DECIMAL(12,3) NOT NULL,
    "physicalQty" DECIMAL(12,3),
    "status" "InventoryCountLineStatus" NOT NULL DEFAULT 'NOT_COUNTED',
    "countedBy" TEXT,
    "countedAt" TIMESTAMP(3),
    "correctionMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_count_lines_sessionId_idx" ON "inventory_count_lines"("sessionId");

-- CreateIndex
CREATE INDEX "inventory_count_lines_ingredientId_idx" ON "inventory_count_lines"("ingredientId");

-- CreateIndex
CREATE INDEX "inventory_count_lines_menuItemId_idx" ON "inventory_count_lines"("menuItemId");

-- AddForeignKey
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "inventory_count_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
