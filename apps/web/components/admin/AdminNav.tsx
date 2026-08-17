"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}
interface NavSection {
  title: string;
  items: NavItem[];
}

function icon(d: string) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
  </svg>
);
const MenuIcon = () => icon("M3 6h18M3 12h18M3 18h18");
const ChartIcon = () => icon("M3 3v18h18 M7 16v-5 M12 16V8 M17 16v-9");
const ClockIcon = () => icon("M12 8v4l3 3 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z");
const VoidIcon = () => icon("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M9 9l6 6 M15 9l-6 6");
const UsersIcon = () => icon("M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75");
const ActivityIcon = () => icon("M22 12h-4l-3 9L9 3l-3 9H2");

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Pregled",
    items: [
      { href: "/dashboard", label: "Kontrolna tabla", icon: <GridIcon /> },
      { href: "/menu", label: "Meni", icon: <MenuIcon /> },
    ],
  },
  {
    title: "Izveštaji",
    items: [
      { href: "/reports/sales", label: "Prodaja", icon: <ChartIcon /> },
      { href: "/reports/shifts", label: "Smene", icon: <ClockIcon /> },
      { href: "/reports/voids", label: "Poništavanja", icon: <VoidIcon /> },
      { href: "/reports/employees", label: "Zaposleni", icon: <UsersIcon /> },
    ],
  },
  {
    title: "Kontrola",
    items: [{ href: "/activity", label: "Evidencija aktivnosti", icon: <ActivityIcon /> }],
  },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <div className="space-y-5">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-widest text-white/40">{section.title}</p>
          <ul className="space-y-0.5 px-2">
            {section.items.map(({ href, label, icon: itemIcon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      active ? "bg-gold/20 text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    <span className={active ? "text-gold" : ""}>{itemIcon}</span>
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
