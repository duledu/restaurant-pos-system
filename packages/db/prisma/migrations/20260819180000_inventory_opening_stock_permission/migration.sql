-- Additive-only: no table/column changes. Adds one permission code and
-- grants it to OWNER/ADMIN only (NOT MANAGER — deliberately stricter than
-- 'inventory.manage', which already covers MANAGER for routine stock
-- receive/adjust/write-off). This gates the new bulk opening-stock
-- initialization/reset action (packages/domain/inventory/inventory-service.ts
-- bulkSetOpeningStock/bulkZeroOpeningStock), which can change every tracked
-- item's stock in one call and is treated as higher-risk than ordinary
-- single-item inventory operations.

INSERT INTO "permissions" ("id", "code", "description")
VALUES
  (gen_random_uuid(), 'inventory.opening_stock', 'Postavljanje/resetovanje početnog stanja zaliha u masovnoj operaciji (go-live inicijalizacija)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r, "permissions" p
WHERE r.name IN ('OWNER', 'ADMIN')
  AND p.code = 'inventory.opening_stock'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r.id AND rp."permissionId" = p.id
  );
