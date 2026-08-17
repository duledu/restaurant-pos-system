"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Kontrolna tabla", icon: <GridIcon /> },
  { href: "/menu", label: "Meni", icon: <MenuIcon /> },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <ul className="space-y-0.5 px-2">
      {NAV_ITEMS.map(({ href, label, icon }) => {
        const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
        return (
          <li key={href}>
            <Link
              href={href}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-gold/20 text-white"
                  : "text-white/70 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <span className={active ? "text-gold" : ""}>{icon}</span>
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
