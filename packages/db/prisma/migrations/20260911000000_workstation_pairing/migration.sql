-- Faza 2A — TableCore Print Agent radne stanice (workstations) + kratkotrajno
-- uparivanje. Aditivna migracija: dva nova enuma/tabele, bez izmena
-- postojećih tabela.
--
-- Ručno pripremljeno iz `prisma migrate diff` izlaza (--from-url na bazu sa
-- primenjenih 22 postojeće migracije, --to-schema-datamodel na trenutni
-- schema.prisma) — isti obrazac kao 20260824210000_device_last_seen — sa
-- ISKLJUČENIM nepovezanim šumom koji `migrate diff` inače dodaje kada se
-- poredi live baza sa datamodel-om:
--   * Drop/Add FOREIGN KEY parovi za SVE postojeće tabele (Prisma diff ih
--     uvek ponovo emituje kad je "to" strana datamodel, ne migracijska
--     istorija — identični su postojećim ograničenjima, ne stvarna izmena).
--   * DropIndex "inventory_items_locationId_idx",
--     DropIndex "menu_items_inventoryTrackingMethod_idx",
--     ALTER COLUMN "updatedAt" DROP DEFAULT (inventory_items/modifier_groups/
--     modifier_options), CREATE UNIQUE INDEX
--     "inventory_movements_paymentId_menuItemId_key" — postojeći šum
--     NEPOVEZAN sa ovom fazom (verovatno ranija drift između schema.prisma i
--     primenjene migracijske istorije, van obima ovog rada) — namerno
--     NETAKNUT ovde, ne rešava se kao deo Faze 2A.

-- CreateEnum
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'CONSUMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "workstation_pairings" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "station" "ProductionStation" NOT NULL,
    "name" TEXT,
    "codeHash" TEXT NOT NULL,
    "status" "PairingStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "workstationId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workstation_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstations" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "station" "ProductionStation" NOT NULL,
    "configuredPrinterName" TEXT,
    "paperWidthMm" INTEGER,
    "agentVersion" TEXT,
    "osDescription" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "lastSuccessfulCommunicationAt" TIMESTAMP(3),
    "lastPrintAt" TIMESTAMP(3),
    "credentialHash" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workstation_pairings_codeHash_key" ON "workstation_pairings"("codeHash");

-- CreateIndex
CREATE INDEX "workstation_pairings_restaurantId_idx" ON "workstation_pairings"("restaurantId");

-- CreateIndex
CREATE INDEX "workstation_pairings_status_idx" ON "workstation_pairings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_credentialHash_key" ON "workstations"("credentialHash");

-- CreateIndex
CREATE INDEX "workstations_restaurantId_idx" ON "workstations"("restaurantId");

-- CreateIndex
CREATE INDEX "workstations_locationId_idx" ON "workstations"("locationId");

-- AddForeignKey
ALTER TABLE "workstation_pairings" ADD CONSTRAINT "workstation_pairings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_pairings" ADD CONSTRAINT "workstation_pairings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstation_pairings" ADD CONSTRAINT "workstation_pairings_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
