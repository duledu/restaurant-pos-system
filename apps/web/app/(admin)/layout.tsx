import Link from "next/link";
import { requireRouteAccess } from "../../lib/route-guard";
import { ADMIN_ROLES } from "@rcs/shared";
import { AppLogo, APP_NAME } from "../../components/branding/AppLogo";
import { AdminNav } from "../../components/admin/AdminNav";
import { LogoutButton } from "../../components/ui/LogoutButton";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRouteAccess(ADMIN_ROLES);

  return (
    <div className="flex min-h-screen">
      {/* ── Sidebar ───────────────────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col bg-graphite">
        {/* Brand */}
        <div className="flex h-14 shrink-0 items-center border-b border-graphite-700 px-4">
          <Link href="/dashboard" aria-label={`${APP_NAME} — Kontrolna tabla`}>
            <AppLogo theme="dark" size="sm" variant="full" />
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4">
          <AdminNav />
        </nav>

        {/* Footer */}
        <div className="shrink-0 border-t border-graphite-700 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-cream-300/30 tracking-wide">{APP_NAME} · v0.1</p>
            <LogoutButton theme="dark" />
          </div>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col pl-56">
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
