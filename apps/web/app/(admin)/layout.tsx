import { requireRouteAccess } from "../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { AdminShell } from "../../components/admin/AdminShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireRouteAccess(ADMIN_ROLES);

  return <AdminShell canViewReservations={ctx.permissions.has("reservations.view")}>{children}</AdminShell>;
}
