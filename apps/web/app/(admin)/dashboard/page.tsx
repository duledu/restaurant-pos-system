"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface MenuItem {
  id: string;
  isActive: boolean;
  needsReview: boolean;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
}

interface Category {
  id: string;
  type: "FOOD" | "DRINK";
}

interface Stats {
  total: number;
  active: number;
  inactive: number;
  needsReview: number;
  kitchen: number;
  bar: number;
  foodCategories: number;
  drinkCategories: number;
}

function StatCard({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-5 ${accent ? "border-gold/40 bg-gold/[0.06]" : "border-line bg-white"}`}>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-inkSoft">{label}</p>
      <p className={`text-3xl font-bold tabular-nums ${accent ? "text-gold" : "text-ink"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-inkSoft">{sub}</p>}
    </div>
  );
}

function QuickLink({ href, label, description, icon }: { href: string; label: string; description: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-lg border border-line bg-white p-4 transition-colors hover:border-gold/50 hover:bg-gold/[0.03]"
    >
      <span className="mt-0.5 shrink-0 text-gold">{icon}</span>
      <div>
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="text-xs text-inkSoft">{description}</p>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/menu/items").then((r) => r.json()),
      fetch("/api/admin/menu/categories").then((r) => r.json()),
    ])
      .then(([itemsRes, catsRes]) => {
        const items: MenuItem[] = itemsRes.items ?? [];
        const categories: Category[] = catsRes.categories ?? [];
        setStats({
          total: items.length,
          active: items.filter((i) => i.isActive).length,
          inactive: items.filter((i) => !i.isActive).length,
          needsReview: items.filter((i) => i.needsReview).length,
          kitchen: items.filter((i) => i.preparationStation === "KITCHEN" || i.preparationStation === "KITCHEN_AND_BAR").length,
          bar: items.filter((i) => i.preparationStation === "BAR" || i.preparationStation === "KITCHEN_AND_BAR").length,
          foodCategories: categories.filter((c) => c.type === "FOOD").length,
          drinkCategories: categories.filter((c) => c.type === "DRINK").length,
        });
      })
      .catch(() => setError("Greška pri učitavanju podataka."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-ink">Kontrolna tabla</h1>
        <p className="mt-1 text-sm text-inkSoft">Pregled sistema za upravljanje restoranom</p>
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Menu stats */}
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Meni</h2>

        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg border border-line bg-white" />
            ))}
          </div>
        ) : stats ? (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Ukupno artikala" value={stats.total} />
              <StatCard label="Aktivnih" value={stats.active} sub={`${Math.round((stats.active / (stats.total || 1)) * 100)}% od ukupnog`} />
              <StatCard label="Neaktivnih" value={stats.inactive} />
              <StatCard
                label="Čeka unos cene"
                value={stats.needsReview}
                sub={stats.needsReview > 0 ? "Potrebna intervencija" : "Sve cene unete"}
                accent={stats.needsReview > 0}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Kategorije hrane" value={stats.foodCategories} />
              <StatCard label="Kategorije pića" value={stats.drinkCategories} />
              <StatCard label="Kuhinja" value={stats.kitchen} sub="artikala za kuhinjsku stanicu" />
              <StatCard label="Šank" value={stats.bar} sub="artikala za šank stanicu" />
            </div>
          </>
        ) : null}
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Brze akcije</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <QuickLink
            href="/menu"
            label="Upravljaj menijem"
            description="Cene, kategorije, aktivacija i dostupnost artikala"
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            }
          />
          <div className="flex items-start gap-3 rounded-lg border border-line bg-ink/[0.018] p-4 opacity-60">
            <span className="mt-0.5 shrink-0 text-inkSoft">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">Stolovi i porudžbine</p>
              <p className="text-xs text-inkSoft">Dolazi uskoro — u narednoj fazi razvoja</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
