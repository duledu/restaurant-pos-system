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
const ItemsIcon = () => icon("M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2 M9 5a2 2 0 0 0 2-2h2a2 2 0 0 0 2 2 M9 12h6 M9 16h4");
const ClockIcon = () => icon("M12 8v4l3 3 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z");
const VoidIcon = () => icon("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M9 9l6 6 M15 9l-6 6");
const UsersIcon = () => icon("M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75");
const StaffIcon = () => icon("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M19 8v6 M22 11h-6");
const ActivityIcon = () => icon("M22 12h-4l-3 9L9 3l-3 9H2");
const DeviceIcon = () => icon("M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M12 18h.01");
const PrinterIcon = () => icon("M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z");
const SettingsIcon = () => icon("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z");
const BoxIcon = () => icon("M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12");
const TablesIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="8" height="6" rx="1" /><rect x="14" y="3" width="8" height="6" rx="1" />
    <rect x="2" y="15" width="8" height="6" rx="1" /><rect x="14" y="15" width="8" height="6" rx="1" />
  </svg>
);

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Pregled",
    items: [
      { href: "/dashboard", label: "Kontrolna tabla", icon: <GridIcon /> },
      { href: "/menu", label: "Meni", icon: <MenuIcon /> },
      { href: "/menu/modifiers", label: "Dodaci", icon: <MenuIcon /> },
      { href: "/inventory", label: "Zalihe", icon: <BoxIcon /> },
      { href: "/tables", label: "Sale i stolovi", icon: <TablesIcon /> },
      { href: "/staff", label: "Osoblje", icon: <StaffIcon /> },
    ],
  },
  {
    title: "Izveštaji",
    items: [
      { href: "/reports/sales", label: "Prodaja", icon: <ChartIcon /> },
      { href: "/reports/items", label: "Prodati artikli", icon: <ItemsIcon /> },
      { href: "/reports/shifts", label: "Smene", icon: <ClockIcon /> },
      { href: "/reports/voids", label: "Poništavanja", icon: <VoidIcon /> },
      { href: "/reports/employees", label: "Zaposleni", icon: <UsersIcon /> },
      { href: "/reports/daily-summary", label: "Dnevni izveštaj", icon: <ClockIcon /> },
      { href: "/reports/kitchen", label: "Kuhinja", icon: <ChartIcon /> },
      { href: "/reports/bar", label: "Bar", icon: <ChartIcon /> },
      { href: "/reports/anti-fraud", label: "Anti-fraud", icon: <VoidIcon /> },
    ],
  },
  {
    title: "Kontrola",
    items: [
      { href: "/activity", label: "Evidencija aktivnosti", icon: <ActivityIcon /> },
      { href: "/device-setup", label: "Uređaji", icon: <DeviceIcon /> },
      { href: "/settings/restaurant", label: "Podešavanja restorana", icon: <SettingsIcon /> },
      { href: "/settings/printers", label: "Štampači", icon: <PrinterIcon /> },
    ],
  },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-5 text-[10px] font-bold uppercase tracking-[0.18em] text-cream-300/40">{section.title}</p>
          <ul className="space-y-1 px-3">
            {section.items.map(({ href, label, icon: itemIcon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className={`relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all ${
                      active ? "bg-white/[0.11] text-white shadow-inner" : "text-white/65 hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    {active && <span className="absolute -left-3 h-6 w-0.5 rounded-r bg-cream-300" aria-hidden="true" />}
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
