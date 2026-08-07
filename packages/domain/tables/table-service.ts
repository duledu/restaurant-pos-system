import { prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";

/**
 * Grid prikaz stolova za konobarski POS — namerno bez punog floor-plan
 * modela (pozicije x/y su extension point za kasniju fazu, vidi
 * docs/01-RCS-Plan-v2-MVP.md). MVP UI grupiše po Floor.name i prikazuje
 * dugmad u redosledu label-a.
 */
export async function listTables(ctx: AuthContext, locationId: string) {
  requireLocationAccess(ctx, locationId);

  const floors = await prisma.floor.findMany({
    where: { ...scopeToRestaurant(ctx), locationId },
    include: {
      tables: {
        where: { isActive: true },
        orderBy: { label: "asc" },
      },
    },
    orderBy: { sortOrder: "asc" },
  });

  return floors;
}

export async function getTable(ctx: AuthContext, tableId: string) {
  const table = await prisma.restaurantTable.findFirst({
    where: {
      id: tableId,
      floor: scopeToRestaurant(ctx),
    },
    include: { floor: true },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);
  return table;
}
