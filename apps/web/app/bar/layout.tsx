import { requireRouteAccess } from "../../lib/route-guard";
import { BAR_ROLES } from "@rcs/shared";

export default async function BarLayout({ children }: { children: React.ReactNode }) {
  await requireRouteAccess(BAR_ROLES);
  return <div className="min-h-screen bg-graphite-900">{children}</div>;
}
