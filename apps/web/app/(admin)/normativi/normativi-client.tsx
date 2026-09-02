"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";
import { RecipeModal } from "../../../components/admin/RecipeModal";

interface Category {
  id: string;
  name: string;
  slug: string;
  type: "FOOD" | "DRINK";
  sortOrder: number;
  isActive: boolean;
}

interface RecipeOverviewItem {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  ingredientCount: number;
  isConfigured: boolean;
  inventoryTrackingMethod: "NO_TRACKING" | "DIRECT_STOCK" | "RECIPE";
}

const UNCAT = "__uncategorized__";
type StatusFilter = "all" | "configured" | "unconfigured";

function TabPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        active ? "border-gold bg-gold-soft text-gold-dark" : "border-line text-inkSoft hover:border-line hover:bg-cream-200/60"
      }`}
    >
      {label}
      {count !== undefined && <span className="text-[10px] opacity-70">{count}</span>}
    </button>
  );
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Greška");
  return body;
}

// Mirrors the inventory.manage grant (OWNER/ADMIN/MANAGER — see the
// 20260819140000_inventory migration) — UX-ONLY hint to avoid showing an
// editable-looking control that would just 403 on save for a view-only role
// (e.g. INVENTORY_MANAGER, which holds menu.view/inventory.view but not
// inventory.manage). The server (recipe-service.ts) remains the sole real
// authorization boundary regardless of what this renders — same established
// pattern as inventory-client.tsx's OPENING_STOCK_ROLES.
const RECIPE_MANAGE_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

export function NormativiClient() {
  const [items, setItems] = useState<RecipeOverviewItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategoryTab, setActiveCategoryTab] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editingItem, setEditingItem] = useState<RecipeOverviewItem | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const canManage = roles.some((r) => RECIPE_MANAGE_ROLES.has(r));

  useEffect(() => {
    // Read-only — used ONLY to decide whether to show editable controls.
    // Real authorization is server-side (inventory.manage), enforced again
    // on every request regardless of what this renders.
    fetch("/api/pos/me").then((r) => r.json()).then((j) => setRoles(j.roles ?? [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recipesRes, catsRes] = await Promise.all([
        apiFetch("/api/admin/recipes"),
        apiFetch("/api/admin/menu/categories"),
      ]);
      setItems(recipesRes.items ?? []);
      setCategories(catsRes.categories ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categoryCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      const key = it.categoryId ?? UNCAT;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const configuredCount = items.filter((i) => i.isConfigured).length;
  const unconfiguredCount = items.length - configuredCount;

  const filtered = useMemo(() => {
    return items.filter((it) => {
      const matchesSearch = it.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory =
        activeCategoryTab === null ||
        (activeCategoryTab === UNCAT ? it.categoryId === null : it.categoryId === activeCategoryTab);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "configured" ? it.isConfigured : !it.isConfigured);
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [items, search, activeCategoryTab, statusFilter]);

  function selectCategoryTab(id: string | null) {
    setActiveCategoryTab((prev) => (prev === id ? null : id));
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Normativi" description="Receptura po artikliju menija — koje sirovine i u kojoj količini ulaze u svaki gotov proizvod" />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line/80 bg-white p-3 shadow-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pretraga artikala…"
          className="max-w-sm flex-1 rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-ink/35"
        />
        <div className="flex gap-1.5">
          <TabPill active={statusFilter === "all"} onClick={() => setStatusFilter("all")} label="Sve" count={items.length} />
          <TabPill active={statusFilter === "configured"} onClick={() => setStatusFilter("configured")} label="Konfigurisano" count={configuredCount} />
          <TabPill active={statusFilter === "unconfigured"} onClick={() => setStatusFilter("unconfigured")} label="Normativ nije definisan" count={unconfiguredCount} />
        </div>
      </div>

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-0.5">
        <TabPill active={activeCategoryTab === null} onClick={() => selectCategoryTab(null)} label="Sve kategorije" />
        {categories.map((cat) => (
          <TabPill
            key={cat.id}
            active={activeCategoryTab === cat.id}
            onClick={() => selectCategoryTab(cat.id)}
            label={cat.name}
            count={categoryCount.get(cat.id)}
          />
        ))}
        {categoryCount.get(UNCAT) ? (
          <TabPill active={activeCategoryTab === UNCAT} onClick={() => selectCategoryTab(UNCAT)} label="Nekategorisano" count={categoryCount.get(UNCAT)} />
        ) : null}
      </div>

      {loading ? (
        <Card className="p-5">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="Nema rezultata" description={items.length === 0 ? "Nema artikala u meniju." : undefined} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-cream-200 text-left text-xs font-semibold uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3">Artikal</th>
                  <th className="px-4 py-3">Kategorija</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Sastojaka</th>
                  <th className="px-4 py-3 text-right">Akcije</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-cream-200/60">
                    <td className="px-4 py-3 font-semibold text-ink">{item.name}</td>
                    <td className="px-4 py-3 text-inkSoft">{item.categoryName ?? "—"}</td>
                    <td className="px-4 py-3 text-center">
                      {item.isConfigured ? (
                        <Badge tone="success">Konfigurisano</Badge>
                      ) : item.inventoryTrackingMethod === "RECIPE" ? (
                        // P1.6: artikal je EKSPLICITNO u RECIPE modu ali bez ijedne linije —
                        // prodaja je blokirana (RecipeNotConfiguredError), ne samo "nije definisano".
                        <Badge tone="danger">Normativ nije podešen</Badge>
                      ) : (
                        <Badge tone="neutral">Normativ nije definisan</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">{item.ingredientCount}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditingItem(item)}
                        className={
                          canManage
                            ? "min-h-11 rounded-md bg-gold-soft px-2.5 py-1.5 text-xs font-semibold text-gold-dark hover:bg-gold/20"
                            : "min-h-11 rounded-md px-2.5 py-1.5 text-xs font-semibold text-inkSoft hover:bg-ink/[.05]"
                        }
                      >
                        {canManage ? "Uredi normativ" : "Pregled"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editingItem && (
        <RecipeModal item={editingItem} onClose={() => setEditingItem(null)} onChanged={load} readOnly={!canManage} />
      )}
    </div>
  );
}
