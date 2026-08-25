import { requireRouteAccess } from "../../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { NormativiClient } from "./normativi-client";

export const metadata = { title: "Normativi" };

export default async function NormativiPage() {
  await requireRouteAccess(ADMIN_ROLES);
  return <NormativiClient />;
}
