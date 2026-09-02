import { requireRouteAccess } from "../../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { InventuraClient } from "./inventura-client";

export const metadata = { title: "Inventura" };

export default async function InventuraPage() {
  await requireRouteAccess(ADMIN_ROLES);
  return <InventuraClient />;
}
