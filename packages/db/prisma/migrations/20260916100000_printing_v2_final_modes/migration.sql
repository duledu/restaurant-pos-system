-- Printing V2 Final — two restaurant-level operational printing modes
-- (LOGIN_AWARE, CENTRAL_ROUTING), deterministic CENTRAL_ROUTING multi-agent
-- routing (isPrimary), and the LOGIN_AWARE terminal-binding table.
--
-- Fully additive/backward-compatible, hand-authored (not `prisma migrate
-- diff`'s raw output, which also picked up unrelated pre-existing schema
-- drift on this shared branch — including the out-of-band
-- `_rcs_database_environment` safety marker table, which must NEVER be
-- touched by an application migration): every restaurant defaults to
-- CENTRAL_ROUTING, which is byte-for-byte the behavior already shipped
-- (a route-configured Agent already claims KITCHEN/BAR/RECEIPT regardless
-- of browser login) — no existing restaurant's behavior changes until an
-- Admin deliberately switches to LOGIN_AWARE. `isPrimary` defaults to false
-- everywhere; with today's single-workstation-per-location physical reality
-- (test_11), the deterministic tie-break (lowest workstationId) is a no-op
-- since there is only ever one candidate. No existing row is altered beyond
-- these new defaulted columns; no table/column is dropped.

-- CreateEnum
CREATE TYPE "PrintingMode" AS ENUM ('LOGIN_AWARE', 'CENTRAL_ROUTING');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "printingMode" "PrintingMode" NOT NULL DEFAULT 'CENTRAL_ROUTING';

-- AlterTable
ALTER TABLE "workstation_print_routes" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workstation_terminal_sessions" (
    "workstationId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "printRole" "PrintJobType" NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstation_terminal_sessions_pkey" PRIMARY KEY ("workstationId")
);

-- CreateIndex
CREATE INDEX "workstation_terminal_sessions_restaurantId_idx" ON "workstation_terminal_sessions"("restaurantId");

-- CreateIndex
CREATE INDEX "workstation_terminal_sessions_employeeId_idx" ON "workstation_terminal_sessions"("employeeId");

-- AddForeignKey
ALTER TABLE "workstation_terminal_sessions" ADD CONSTRAINT "workstation_terminal_sessions_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
