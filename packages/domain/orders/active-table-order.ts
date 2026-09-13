import { prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { getTable } from "../tables/table-service";
import { getActiveShift } from "../shifts/shift-service";
import { requireDraftOwnership, requireOrderOperator } from "./order-access";

/** Inspection never opens an order. Resolve identity and rows in the same read,
 * rather than trusting a possibly stale table-summary order ID. */
export async function getActiveTableOrder(ctx: AuthContext, tableId: string) {
  requireOrderOperator(ctx);
  const table = await getTable(ctx, tableId); // tenant, location and active-table gates
  if (!await getActiveShift(ctx, table.floor.locationId)) throw new Error("Nema aktivne smene na ovoj lokaciji — otvori smenu pre unosa porudžbina");
  const order = await prisma.order.findFirst({
    where: { ...scopeToRestaurant(ctx), tableId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    include: { items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } }, table: true },
  });
  if (order) {
    requireLocationAccess(ctx, order.locationId);
    if (order.locationId !== table.floor.locationId) throw new Error("Porudžbina nije na lokaciji stola");
    if (order.status === "DRAFT") requireDraftOwnership(ctx, order.openedBy);
  }
  return { table: { id: table.id, label: table.label, locationId: table.floor.locationId }, order };
}
