import { requireRouteAccess } from "../../lib/route-guard";
import { WAITER_ROLES } from "@rcs/shared";

export default async function WaiterLayout({ children }: { children: React.ReactNode }) {
  await requireRouteAccess(WAITER_ROLES);
  return <div className="min-h-screen bg-cream">{children}</div>;
}
