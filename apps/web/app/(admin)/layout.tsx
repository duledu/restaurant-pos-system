import { requireRouteAccess } from "../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRouteAccess(ADMIN_ROLES);

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-line bg-graphite px-6 py-4">
        <span className="font-display text-lg font-medium text-cream-100">Evropa MM</span>
        <span className="ml-3 text-xs text-cream-300/60">Administracija</span>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
