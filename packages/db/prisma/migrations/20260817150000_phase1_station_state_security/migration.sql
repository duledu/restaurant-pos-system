-- Persistent, serverless-safe email login throttling. The key is a SHA-256
-- digest of the normalized email, never the email itself.
CREATE TABLE "login_throttles" (
  "key" TEXT PRIMARY KEY,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "login_throttles_lockedUntil_idx" ON "login_throttles"("lockedUntil");

-- Independent kitchen/bar progress for one commercial OrderItem.
CREATE TYPE "ProductionStation" AS ENUM ('KITCHEN', 'BAR');

CREATE TABLE "order_item_stations" (
  "id" TEXT PRIMARY KEY,
  "orderItemId" TEXT NOT NULL REFERENCES "order_items"("id") ON DELETE CASCADE,
  "station" "ProductionStation" NOT NULL,
  "status" "OrderItemStatus" NOT NULL DEFAULT 'SUBMITTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "order_item_stations_orderItemId_station_key"
  ON "order_item_stations"("orderItemId", "station");
CREATE INDEX "order_item_stations_station_status_idx"
  ON "order_item_stations"("station", "status");

-- Backfill already-submitted production items. KITCHEN_AND_BAR intentionally
-- gets two independent rows initialized to the legacy aggregate status.
INSERT INTO "order_item_stations" ("id", "orderItemId", "station", "status", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text || oi."id"), oi."id", 'KITCHEN'::"ProductionStation", oi."status", now(), now()
FROM "order_items" oi
WHERE oi."status" <> 'DRAFT'
  AND oi."preparationStation" IN ('KITCHEN', 'KITCHEN_AND_BAR');

INSERT INTO "order_item_stations" ("id", "orderItemId", "station", "status", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text || oi."id"), oi."id", 'BAR'::"ProductionStation", oi."status", now(), now()
FROM "order_items" oi
WHERE oi."status" <> 'DRAFT'
  AND oi."preparationStation" IN ('BAR', 'KITCHEN_AND_BAR');

-- Items explicitly configured with no production station require no KDS work.
UPDATE "order_items"
SET "status" = 'SERVED', "updatedAt" = now()
WHERE "status" NOT IN ('DRAFT', 'CANCELLED') AND "preparationStation" = 'NONE';
