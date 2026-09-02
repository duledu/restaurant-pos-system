import { requireRouteAccess } from "../../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { IngredientsClient } from "./ingredients-client";

export const metadata = { title: "Sirovine" };

export default async function IngredientsPage() {
  await requireRouteAccess(ADMIN_ROLES);
  return <IngredientsClient />;
}
