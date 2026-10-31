import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant } from "@rcs/auth";
import { requireRouteAccess } from "./route-guard";

/** Both entry points use the authenticated restaurant, location access and
 * existing reservation permissions. Never accept these from URL parameters. */
export async function reservationPageProps(roles: string[]) {
  const ctx = await requireRouteAccess(roles);
  requirePermission(ctx, "reservations.view");
  const [restaurant, locations] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId }, select: { timezone: true } }),
    prisma.location.findMany({ where: { ...scopeToRestaurant(ctx), id: { in: ctx.locationIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { locations, timeZone: restaurant.timezone, canManage: ctx.permissions.has("reservations.manage") };
}
