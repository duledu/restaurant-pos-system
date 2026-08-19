import { requireRouteAccess } from "../../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { InventoryClient } from "./inventory-client";

export const metadata = { title: "Zalihe" };

export default async function InventoryPage() {
  await requireRouteAccess(ADMIN_ROLES);
  return <InventoryClient />;
}
