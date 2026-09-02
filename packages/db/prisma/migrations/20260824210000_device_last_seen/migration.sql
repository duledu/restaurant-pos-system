-- Admin Device Management: additive, nullable lastSeenAt on Device — best-
-- effort/throttled activity tracking (see packages/auth/rbac.ts requireAuth),
-- informational only, never used for authorization.
--
-- Hand-assembled from `prisma migrate diff` output — contains ONLY the one
-- genuinely new statement below. Deliberately EXCLUDES the following
-- pre-existing, unrelated drift that appears in the raw diff:
--   - DROP INDEX "inventory_items_locationId_idx"
--   - ALTER TABLE "inventory_items"/"modifier_groups"/"modifier_options"
--     ALTER COLUMN "updatedAt" DROP DEFAULT
--   - DROP TABLE "_rcs_database_environment" (marker table is deliberately
--     NOT part of the Prisma schema — see scripts/lib/db-environment.mjs)
--   - CREATE UNIQUE INDEX "inventory_movements_paymentId_menuItemId_key"
--     (pre-existing drift, unrelated to this change, left untouched)

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);
