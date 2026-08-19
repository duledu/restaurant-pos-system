-- InventoryItem + InventoryMovement (Faza 7)
-- Bezbedna aditivna migracija — ne menja nijedan postojeći red.

-- MovementType enum
CREATE TYPE "MovementType" AS ENUM (
  'INITIAL',
  'OPENING_STOCK',
  'RECEIPT',
  'SALE',
  'ADJUSTMENT',
  'WRITE_OFF'
);

-- InventoryItem: jedno stanje zaliha po (location, menuItem) paru
CREATE TABLE "inventory_items" (
  "id"           TEXT            NOT NULL,
  "restaurantId" TEXT            NOT NULL,
  "locationId"   TEXT            NOT NULL,
  "menuItemId"   TEXT            NOT NULL,
  "currentStock" DECIMAL(12,3)   NOT NULL DEFAULT 0,
  "unit"         TEXT            NOT NULL DEFAULT 'kom',
  "createdAt"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- InventoryMovement: nepromenjiv ledger kretanja zaliha
CREATE TABLE "inventory_movements" (
  "id"              TEXT            NOT NULL,
  "restaurantId"    TEXT            NOT NULL,
  "locationId"      TEXT            NOT NULL,
  "menuItemId"      TEXT            NOT NULL,
  "inventoryItemId" TEXT            NOT NULL,
  "type"            "MovementType"  NOT NULL,
  "quantityDelta"   DECIMAL(12,3)   NOT NULL,
  "quantityBefore"  DECIMAL(12,3)   NOT NULL,
  "quantityAfter"   DECIMAL(12,3)   NOT NULL,
  "paymentId"       TEXT,
  "orderId"         TEXT,
  "employeeId"      TEXT,
  "reason"          TEXT,
  "createdAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "inventory_items_locationId_menuItemId_key"
  ON "inventory_items"("locationId", "menuItemId");

-- Partial unique index: paymentId idempotency (NULLs excluded — each non-SALE
-- movement is allowed to coexist regardless of other NULL paymentId rows)
CREATE UNIQUE INDEX "inventory_movements_paymentId_menuItemId_key"
  ON "inventory_movements"("paymentId", "menuItemId")
  WHERE "paymentId" IS NOT NULL;

-- Indexes
CREATE INDEX "inventory_items_restaurantId_idx" ON "inventory_items"("restaurantId");
CREATE INDEX "inventory_items_locationId_idx"   ON "inventory_items"("locationId");
CREATE INDEX "inventory_items_menuItemId_idx"   ON "inventory_items"("menuItemId");

CREATE INDEX "inventory_movements_inventoryItemId_idx" ON "inventory_movements"("inventoryItemId");
CREATE INDEX "inventory_movements_restaurantId_idx"    ON "inventory_movements"("restaurantId");
CREATE INDEX "inventory_movements_locationId_idx"      ON "inventory_movements"("locationId");
CREATE INDEX "inventory_movements_menuItemId_idx"      ON "inventory_movements"("menuItemId");
CREATE INDEX "inventory_movements_paymentId_idx"       ON "inventory_movements"("paymentId");
CREATE INDEX "inventory_movements_createdAt_idx"       ON "inventory_movements"("createdAt");

-- Foreign keys
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_inventoryItemId_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Permissions seed ────────────────────────────────────────────────────────
-- Add inventory permissions (idempotent INSERT)
INSERT INTO "permissions" ("id", "code", "description")
VALUES
  (gen_random_uuid(), 'inventory.view',   'Pregled stanja zaliha'),
  (gen_random_uuid(), 'inventory.manage', 'Upravljanje zalihama: primanje robe, korekcije, otpis')
ON CONFLICT ("code") DO NOTHING;

-- Grant to all OWNER/ADMIN/MANAGER/INVENTORY_MANAGER roles across all restaurants
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r, "permissions" p
WHERE r.name IN ('OWNER', 'ADMIN', 'MANAGER')
  AND p.code IN ('inventory.view', 'inventory.manage')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r, "permissions" p
WHERE r.name = 'INVENTORY_MANAGER'
  AND p.code = 'inventory.view'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
