import { requireRouteAccess } from "../../lib/route-guard";
import { KITCHEN_ROLES } from "@rcs/shared";

export default async function KitchenLayout({ children }: { children: React.ReactNode }) {
  await requireRouteAccess(KITCHEN_ROLES);
  return <div className="min-h-screen bg-graphite-900">{children}</div>;
}
