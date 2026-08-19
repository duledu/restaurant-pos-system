"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AppLogo, APP_NAME } from "../branding/AppLogo";
import { AdminNav } from "./AdminNav";
import { LogoutButton } from "../ui/LogoutButton";
import { QuickLockButton } from "../ui/QuickLockButton";

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Shared chrome content — identical markup rendered once for the desktop
 * fixed sidebar and once inside the mobile drawer, so the two never drift
 * (same nav items, same role-gated links, same footer actions). */
function SidebarContent({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) {
  return (
    <>
      <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-white/10 px-5">
        <Link href="/dashboard" aria-label={`${APP_NAME} — Kontrolna tabla`} onClick={onNavigate}>
          <AppLogo theme="dark" size="sm" variant="full" />
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-white/70 hover:bg-white/[0.06] hover:text-white"
            aria-label="Zatvori meni"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-5" onClick={onNavigate}>
        <AdminNav />
      </nav>

      <div className="shrink-0 border-t border-white/10 bg-graphite-900/30 px-4 py-4">
        <div className="mb-2 px-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cream-300/40">Operativni sistem</p>
          <p className="mt-0.5 text-xs text-white/65">Bezbedna administratorska sesija</p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
          <p className="text-[10px] text-cream-300/30 tracking-wide">{APP_NAME} · v0.1</p>
          <div className="flex items-center gap-1">
            <QuickLockButton theme="dark" />
            <LogoutButton theme="dark" />
          </div>
        </div>
      </div>
    </>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever navigation happens (route change), so it
  // never stays open after tapping a nav link.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen">
      {/* ── Desktop sidebar (unchanged) ─────────────────────────────────── */}
      <aside className="no-print fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-white/10 bg-gradient-to-b from-graphite to-graphite-900 shadow-[4px_0_24px_rgba(6,17,30,.08)] md:flex">
        <SidebarContent />
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────────────── */}
      <header className="no-print sticky top-0 z-30 flex h-16 w-full shrink-0 items-center justify-between border-b border-line bg-white/95 px-4 shadow-sm backdrop-blur md:hidden">
        <Link href="/dashboard" aria-label={`${APP_NAME} — Kontrolna tabla`}>
          <AppLogo size="sm" variant="full" />
        </Link>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-white text-graphite shadow-sm active:translate-y-px"
          aria-label="Otvori meni"
          aria-expanded={drawerOpen}
        >
          <MenuIcon />
        </button>
      </header>

      {/* ── Mobile drawer ────────────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="md:hidden">
          <button
            type="button"
            aria-label="Zatvori meni"
            onClick={() => setDrawerOpen(false)}
            className="no-print fixed inset-0 z-40 bg-graphite-900/50"
          />
          <div className="no-print fixed left-0 top-0 z-50 flex h-[100dvh] w-[86vw] max-w-80 animate-slide-up flex-col bg-graphite shadow-elevated">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} onClose={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-64 print:pl-0">
        <main className="flex-1 overflow-x-hidden p-4 sm:p-5 md:p-7 lg:p-8 print:p-0">{children}</main>
      </div>
    </div>
  );
}
