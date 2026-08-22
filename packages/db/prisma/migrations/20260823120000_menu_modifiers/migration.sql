-- P3.2 — Menu Modifiers & Extras
-- Bezbedna aditivna migracija — SAMO nove tabele, ne dira nijedan postojeći
-- red/kolonu/tabelu. OrderItem.price OD SADA (aplikativno, ne DB) znači
-- "efektivna jedinična cena" (osnovna + izabrani dodaci) — postojeće
-- kolone/tabele se ne menjaju, samo se dodaje novi skup redova.

-- ModifierGroup: grupa dodataka (npr. "Veličina", "Dodaci"), restoran-wide
-- (isto vlasništvo kao MenuItem — nema locationId, vidi MenuItem komentar).
CREATE TABLE "modifier_groups" (
  "id"           TEXT           NOT NULL,
  "restaurantId" TEXT           NOT NULL,
  "name"         TEXT           NOT NULL,
  "required"     BOOLEAN        NOT NULL DEFAULT false,
  "minSelect"    INTEGER        NOT NULL DEFAULT 0,
  "maxSelect"    INTEGER        NOT NULL DEFAULT 1,
  "sortOrder"    INTEGER        NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN        NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- ModifierOption: pojedinačna opcija unutar grupe (npr. "Kačkavalj +100").
CREATE TABLE "modifier_options" (
  "id"              TEXT           NOT NULL,
  "modifierGroupId" TEXT           NOT NULL,
  "name"            TEXT           NOT NULL,
  "priceDelta"      DECIMAL(12,2)  NOT NULL DEFAULT 0,
  "sortOrder"       INTEGER        NOT NULL DEFAULT 0,
  "isActive"        BOOLEAN        NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- MenuItem <-> ModifierGroup: many-to-many join (grupe se mogu deliti između
-- više artikala, npr. "Dodaci za picu" na svim picama).
CREATE TABLE "menu_item_modifier_groups" (
  "id"              TEXT         NOT NULL,
  "menuItemId"      TEXT         NOT NULL,
  "modifierGroupId" TEXT         NOT NULL,
  "sortOrder"       INTEGER      NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "menu_item_modifier_groups_pkey" PRIMARY KEY ("id")
);

-- OrderItemModifier: nepromenjiv istorijski snapshot izabrane opcije na
-- porudžbinskoj stavci (naziv grupe/opcije/cena zamrznuti u trenutku izbora).
CREATE TABLE "order_item_modifiers" (
  "id"               TEXT          NOT NULL,
  "orderItemId"      TEXT          NOT NULL,
  "modifierOptionId" TEXT,
  "groupName"        TEXT          NOT NULL,
  "optionName"       TEXT          NOT NULL,
  "priceDelta"       DECIMAL(12,2) NOT NULL,
  "sortOrder"        INTEGER       NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "modifier_groups_restaurantId_idx" ON "modifier_groups"("restaurantId");
CREATE INDEX "modifier_groups_restaurantId_isActive_idx" ON "modifier_groups"("restaurantId", "isActive");

CREATE INDEX "modifier_options_modifierGroupId_idx" ON "modifier_options"("modifierGroupId");

CREATE UNIQUE INDEX "menu_item_modifier_groups_menuItemId_modifierGroupId_key"
  ON "menu_item_modifier_groups"("menuItemId", "modifierGroupId");
CREATE INDEX "menu_item_modifier_groups_menuItemId_idx" ON "menu_item_modifier_groups"("menuItemId");
CREATE INDEX "menu_item_modifier_groups_modifierGroupId_idx" ON "menu_item_modifier_groups"("modifierGroupId");

CREATE INDEX "order_item_modifiers_orderItemId_idx" ON "order_item_modifiers"("orderItemId");
CREATE INDEX "order_item_modifiers_modifierOptionId_idx" ON "order_item_modifiers"("modifierOptionId");

-- Foreign keys
ALTER TABLE "modifier_groups"
  ADD CONSTRAINT "modifier_groups_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "modifier_options"
  ADD CONSTRAINT "modifier_options_modifierGroupId_fkey"
  FOREIGN KEY ("modifierGroupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "menu_item_modifier_groups"
  ADD CONSTRAINT "menu_item_modifier_groups_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_modifier_groups"
  ADD CONSTRAINT "menu_item_modifier_groups_modifierGroupId_fkey"
  FOREIGN KEY ("modifierGroupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_item_modifiers"
  ADD CONSTRAINT "order_item_modifiers_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item_modifiers"
  ADD CONSTRAINT "order_item_modifiers_modifierOptionId_fkey"
  FOREIGN KEY ("modifierOptionId") REFERENCES "modifier_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;
