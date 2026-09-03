"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { RecipeButton } from "../../../components/admin/RecipeModal";

interface Category {
  id: string;
  name: string;
  slug: string;
  type: "FOOD" | "DRINK";
  sortOrder: number;
  isActive: boolean;
}

interface MenuItem {
  id: string;
  name: string;
  slug: string;
  price: string;
  quantity: string | null;
  unit: string | null;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
  isActive: boolean;
  isAvailable: boolean;
  needsReview: boolean;
  reviewNote: string | null;
  category: Category | null;
  categoryId: string | null;
  // P1.6: eksplicitna metoda praćenja zaliha — NIKAD izvedena iz kategorije.
  inventoryTrackingMethod: "NO_TRACKING" | "DIRECT_STOCK" | "RECIPE";
}

const TRACKING_METHOD_LABEL: Record<MenuItem["inventoryTrackingMethod"], string> = {
  NO_TRACKING: "Ne prati zalihe",
  DIRECT_STOCK: "Gotov proizvod / direktno stanje",
  RECIPE: "Receptura / normativ",
};

const STATION_LABEL: Record<MenuItem["preparationStation"], string> = {
  KITCHEN: "Kuhinja",
  BAR: "Šank",
  KITCHEN_AND_BAR: "K + Š",
  NONE: "—",
};

const STATION_BADGE: Record<MenuItem["preparationStation"], string> = {
  KITCHEN:         "bg-warn-soft text-warn",
  BAR:             "bg-info-soft text-info",
  KITCHEN_AND_BAR: "bg-ink/[0.07] text-ink/70",
  NONE:            "",
};

const UNCAT = "__uncategorized__";

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

// ── Main component ────────────────────────────────────────────────────────────

// Mirrors the inventory.manage grant (OWNER/ADMIN/MANAGER) — see the same
// note on RECIPE_MANAGE_ROLES in normativi-client.tsx. UX-only; the server
// remains the sole real authorization boundary.
const RECIPE_MANAGE_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

export function MenuManagementClient() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const canManageRecipes = roles.some((r) => RECIPE_MANAGE_ROLES.has(r));

  useEffect(() => {
    fetch("/api/pos/me").then((r) => r.json()).then((j) => setRoles(j.roles ?? [])).catch(() => {});
  }, []);

  // Server-side filters (trigger reload)
  const [search, setSearch] = useState("");
  const [stationFilter, setStationFilter] = useState<"" | MenuItem["preparationStation"]>("");

  // Client-side filters (no reload)
  const [showInactive, setShowInactive] = useState(true);
  const [activeCategoryTab, setActiveCategoryTab] = useState<string | null>(null);
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set());

  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (stationFilter) params.set("station", stationFilter);

      const [itemsRes, categoriesRes] = await Promise.all([
        apiFetch(`/api/admin/menu/items?${params}`),
        apiFetch(`/api/admin/menu/categories`),
      ]);
      setItems(itemsRes.items);
      setCategories(categoriesRes.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, [search, stationFilter]);

  useEffect(() => { load(); }, [load]);

  // Group items by categoryId; uncategorized items go into UNCAT bucket
  const grouped = useMemo(() => {
    const visible = showInactive ? items : items.filter((i) => i.isActive);
    const map = new Map<string, MenuItem[]>();
    map.set(UNCAT, []);
    for (const cat of categories) map.set(cat.id, []);
    for (const item of visible) {
      const key = item.categoryId && map.has(item.categoryId) ? item.categoryId : UNCAT;
      map.get(key)!.push(item);
    }
    return map;
  }, [items, categories, showInactive]);

  const uncategorizedItems = grouped.get(UNCAT) ?? [];
  const totalVisible = Array.from(grouped.values()).reduce((s, a) => s + a.length, 0);

  // Which category sections to render based on the active tab
  const visibleCats = useMemo(() => {
    if (activeCategoryTab === UNCAT) return [];
    if (activeCategoryTab) return categories.filter((c) => c.id === activeCategoryTab);
    return categories;
  }, [categories, activeCategoryTab]);

  const showUncatSection = activeCategoryTab === null || activeCategoryTab === UNCAT;

  // When searching, force all sections open; when a specific tab is focused, keep it open
  function isSectionCollapsed(id: string) {
    if (search) return false;
    if (activeCategoryTab === id) return false;
    return collapsedSet.has(id);
  }

  function toggleCollapse(id: string) {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectTab(id: string | null) {
    setActiveCategoryTab((prev) => (prev === id ? null : id));
  }

  // ── Action handlers (all unchanged) ──────────────────────────────────────

  async function savePrice(id: string) {
    const price = Number(priceDraft);
    if (Number.isNaN(price) || price < 0) { setError("Neispravna cena"); return; }
    try {
      await apiFetch(`/api/admin/menu/items/${id}/price`, {
        method: "POST",
        body: JSON.stringify({ price }),
      });
      setEditingPriceId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri izmeni cene");
    }
  }

  async function toggleActive(item: MenuItem) {
    try {
      await apiFetch(`/api/admin/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function toggleAvailable(item: MenuItem) {
    try {
      await apiFetch(`/api/admin/menu/items/${item.id}/availability`, {
        method: "POST",
        body: JSON.stringify({ isAvailable: !item.isAvailable }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function duplicateItem(id: string) {
    try {
      await apiFetch(`/api/admin/menu/items/${id}/duplicate`, { method: "POST" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function archiveItem(id: string) {
    if (!confirm("Arhiviraj artikal? Neće se više prikazivati, ali istorija porudžbina ostaje netaknuta.")) return;
    try {
      await apiFetch(`/api/admin/menu/items/${id}/archive`, { method: "POST" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function deleteItem(id: string) {
    if (!confirm("Trajno obriši artikal? Ova akcija se ne može poništiti.")) return;
    try {
      await apiFetch(`/api/admin/menu/items/${id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function moveToCategory(id: string, categoryId: string) {
    try {
      await apiFetch(`/api/admin/menu/items/${id}/category`, {
        method: "POST",
        body: JSON.stringify({ categoryId: categoryId || null }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Greška"); }
  }

  async function setTrackingMethod(
    item: MenuItem,
    method: MenuItem["inventoryTrackingMethod"],
    confirm_: { confirmSwitchAwayFromDirectStock?: boolean; confirmReactivateDirectStock?: boolean } = {}
  ) {
    try {
      await apiFetch(`/api/admin/menu/items/${item.id}/inventory-tracking-method`, {
        method: "POST",
        body: JSON.stringify({ method, ...confirm_ }),
      });
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Greška";
      // P1.6: dve odvojene bezbednosne provere (DirectStockStillPresentError
      // pri napuštanju DIRECT_STOCK sa preostalom zalihom; StaleDirectStockQuantityError
      // pri povratku na DIRECT_STOCK preko zastarelog zapisa) nisu obične
      // greške — nude potvrdu i ponove zahtev sa odgovarajućim flagom, isti
      // obrazac kao archiveItem/deleteItem dijalozi iznad (window.confirm,
      // nema toast infrastrukture u ovom adminu).
      if (message.includes("i dalje ima zalihu") && confirm(`${message}\n\nNastaviti?`)) {
        return setTrackingMethod(item, method, { confirmSwitchAwayFromDirectStock: true });
      }
      if (message.includes("zastareo") && confirm(`${message}\n\nNastaviti?`)) {
        return setTrackingMethod(item, method, { confirmReactivateDirectStock: true });
      }
      setError(message);
    }
  }

  const priceEdit: PriceEditState = { editingPriceId, priceDraft, setEditingPriceId, setPriceDraft };
  const actions: ItemActions = { savePrice, toggleActive, toggleAvailable, duplicateItem, archiveItem, deleteItem, moveToCategory, setTrackingMethod, refresh: load };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center justify-between rounded-md border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-3 text-danger/50 hover:text-danger">✕</button>
        </div>
      )}

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white px-3 py-2.5">
        {/* Search */}
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink/50"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            className="w-52 rounded-sm border border-line py-1.5 pl-8 pr-3 text-sm placeholder:text-ink/50 focus:border-gold focus:outline-none"
            placeholder="Pretraga artikala…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Station filter — segmented control */}
        <div className="flex overflow-hidden rounded-sm border border-line">
          {(["", "KITCHEN", "BAR"] as const).map((s, i) => (
            <button
              key={s}
              onClick={() => setStationFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${i > 0 ? "border-l border-line" : ""} ${
                stationFilter === s
                  ? "bg-graphite text-white"
                  : "bg-white text-ink/70 hover:bg-ink/[0.04]"
              }`}
            >
              {s === "" ? "Sve stanice" : s === "KITCHEN" ? "Kuhinja" : "Šank"}
            </button>
          ))}
        </div>

        {/* Show inactive */}
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink/70">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Prikaži neaktivne
        </label>

        <span className="text-xs text-ink/55">{loading ? "…" : `${totalVisible} stavki`}</span>

        <div className="ml-auto">
          <button
            onClick={() => setShowAddForm(true)}
            className="min-h-11 rounded-sm bg-gold px-4 py-1.5 text-sm font-medium text-white hover:bg-gold-dark transition-colors"
          >
            + Dodaj artikal
          </button>
        </div>
      </div>

      {/* ── Category tab strip ───────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        <TabPill
          active={activeCategoryTab === null}
          onClick={() => setActiveCategoryTab(null)}
          label="Sve kategorije"
          count={null}
        />
        {categories.map((cat) => (
          <TabPill
            key={cat.id}
            active={activeCategoryTab === cat.id}
            onClick={() => selectTab(cat.id)}
            label={cat.name}
            count={grouped.get(cat.id)?.length ?? 0}
            dot={cat.type === "FOOD" ? "food" : "drink"}
          />
        ))}
        {uncategorizedItems.length > 0 && (
          <TabPill
            active={activeCategoryTab === UNCAT}
            onClick={() => selectTab(UNCAT)}
            label="Nekategorisano"
            count={uncategorizedItems.length}
          />
        )}
      </div>

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className="rounded-md border border-line bg-white px-4 py-12 text-center text-sm text-ink/55">
          Učitavanje menija…
        </div>
      )}

      {/* ── Category sections ────────────────────────────────────────────── */}
      {!loading && (
        <div className="space-y-2">
          {visibleCats.map((cat) => {
            const catItems = grouped.get(cat.id) ?? [];
            if (catItems.length === 0 && !search) return null;
            return (
              <CategorySection
                key={cat.id}
                sectionId={cat.id}
                label={cat.name}
                typeLabel={cat.type === "FOOD" ? "Hrana" : "Piće"}
                typeColor={cat.type === "FOOD" ? "food" : "drink"}
                items={catItems}
                categories={categories}
                isCollapsed={isSectionCollapsed(cat.id)}
                onToggleCollapse={() => toggleCollapse(cat.id)}
                priceEdit={priceEdit}
                actions={actions}
                canManageRecipes={canManageRecipes}
              />
            );
          })}

          {showUncatSection && uncategorizedItems.length > 0 && (
            <CategorySection
              key={UNCAT}
              sectionId={UNCAT}
              label="Nekategorisano"
              typeLabel={null}
              typeColor={null}
              items={uncategorizedItems}
              categories={categories}
              isCollapsed={isSectionCollapsed(UNCAT)}
              onToggleCollapse={() => toggleCollapse(UNCAT)}
              priceEdit={priceEdit}
              actions={actions}
              canManageRecipes={canManageRecipes}
            />
          )}

          {totalVisible === 0 && (
            <div className="rounded-md border border-line bg-white px-4 py-10 text-center text-sm text-ink/55">
              Nema artikala za ove filtere.
            </div>
          )}
        </div>
      )}

      {showAddForm && (
        <AddItemForm
          categories={categories}
          onClose={() => setShowAddForm(false)}
          onCreated={async () => { setShowAddForm(false); await load(); }}
          setError={setError}
        />
      )}
    </div>
  );
}

// ── TabPill ───────────────────────────────────────────────────────────────────

function TabPill({
  active,
  onClick,
  label,
  count,
  dot,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
  dot?: "food" | "drink";
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-graphite text-white"
          : "border border-line bg-white text-ink/75 hover:bg-ink/[0.04]"
      }`}
    >
      {dot && (
        <span className={`h-1.5 w-1.5 rounded-full ${
          dot === "food" ? "bg-success" : "bg-info"
        } ${active ? "opacity-60" : ""}`} />
      )}
      {label}
      {count !== null && count > 0 && (
        <span className={`rounded-full px-1.5 tabular-nums text-[10px] ${
          active ? "bg-white/20 text-white" : "bg-ink/[0.07] text-ink/55"
        }`}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── Shared types ──────────────────────────────────────────────────────────────

interface PriceEditState {
  editingPriceId: string | null;
  priceDraft: string;
  setEditingPriceId: (id: string | null) => void;
  setPriceDraft: (v: string) => void;
}

interface ItemActions {
  savePrice: (id: string) => void;
  toggleActive: (item: MenuItem) => void;
  toggleAvailable: (item: MenuItem) => void;
  duplicateItem: (id: string) => void;
  archiveItem: (id: string) => void;
  deleteItem: (id: string) => void;
  moveToCategory: (id: string, categoryId: string) => void;
  setTrackingMethod: (item: MenuItem, method: MenuItem["inventoryTrackingMethod"]) => void;
  refresh: () => void;
}

// ── CategorySection ───────────────────────────────────────────────────────────

function CategorySection({
  sectionId,
  label,
  typeLabel,
  typeColor,
  items,
  categories,
  isCollapsed,
  onToggleCollapse,
  priceEdit,
  actions,
  canManageRecipes,
}: {
  sectionId: string;
  label: string;
  typeLabel: string | null;
  typeColor: "food" | "drink" | null;
  items: MenuItem[];
  categories: Category[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  priceEdit: PriceEditState;
  actions: ItemActions;
  canManageRecipes: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-white">
      {/* Section header */}
      <button
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-ink/[0.015]"
      >
        <span className="w-2.5 shrink-0 text-[10px] text-ink/35">
          {isCollapsed ? "▶" : "▼"}
        </span>
        <span className="text-sm font-semibold text-ink">{label}</span>
        {typeLabel && (
          <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
            typeColor === "food"
              ? "bg-success-soft text-success"
              : "bg-info-soft text-info"
          }`}>
            {typeLabel}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-ink/60">
          {items.length} {items.length === 1 ? "stavka" : "stavki"}
        </span>
      </button>

      {/* Item table */}
      {!isCollapsed && (
        <div className="border-t border-line">
          {items.length === 0 ? (
            <p className="px-4 py-5 text-sm italic text-ink/55">
              Nema artikala koji odgovaraju filterima.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-ink/[0.018] text-left text-[11px] uppercase tracking-wide text-ink/60">
                    <th className="px-4 py-2 font-medium">Naziv</th>
                    <th className="w-36 px-4 py-2 font-medium">Cena</th>
                    <th className="w-24 px-4 py-2 font-medium">Stanica</th>
                    <th className="w-20 px-4 py-2 text-center font-medium">Dostupno</th>
                    <th className="w-20 px-4 py-2 text-center font-medium">Aktivno</th>
                    <th className="w-44 px-4 py-2 font-medium">Praćenje zaliha</th>
                    <th className="w-36 px-4 py-2 font-medium">Premesti</th>
                    <th className="w-36 px-4 py-2 font-medium">Akcije</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      categories={categories}
                      priceEdit={priceEdit}
                      actions={actions}
                      canManageRecipes={canManageRecipes}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ItemRow ───────────────────────────────────────────────────────────────────

function ItemRow({
  item,
  categories,
  priceEdit,
  actions,
  canManageRecipes,
}: {
  item: MenuItem;
  categories: Category[];
  priceEdit: PriceEditState;
  actions: ItemActions;
  canManageRecipes: boolean;
}) {
  const { editingPriceId, priceDraft, setEditingPriceId, setPriceDraft } = priceEdit;
  const { savePrice, toggleActive, toggleAvailable, duplicateItem, archiveItem, deleteItem, moveToCategory, setTrackingMethod, refresh } = actions;
  const isEditing = editingPriceId === item.id;

  return (
    <tr className={`border-b border-line last:border-0 transition-colors hover:bg-ink/[0.014] ${!item.isActive ? "opacity-50" : ""}`}>
      {/* Name */}
      <td className="px-4 py-2.5">
        <span className="font-medium text-ink">{item.name}</span>
        {item.quantity != null && (
          <span className="ml-2 text-xs text-ink/60">
            {item.quantity}{item.unit ? ` ${item.unit}` : ""}
          </span>
        )}
        {item.needsReview && (
          <span className="ml-1.5 inline-block align-middle rounded-sm bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-warn">
            ⚠ cena
          </span>
        )}
      </td>

      {/* Price */}
      <td className="px-4 py-2.5">
        {isEditing ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              className="w-20 rounded-sm border border-gold/60 px-1.5 py-1 text-xs focus:border-gold focus:outline-none"
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") savePrice(item.id);
                if (e.key === "Escape") setEditingPriceId(null);
              }}
            />
            <button
              onClick={() => savePrice(item.id)}
              className="rounded-sm bg-gold px-2 py-0.5 text-[11px] font-medium text-white hover:bg-gold-dark"
            >
              ✓
            </button>
            <button onClick={() => setEditingPriceId(null)} className="text-xs text-ink/55 hover:text-ink/80">
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setEditingPriceId(item.id); setPriceDraft(item.price); }}
            className={`rounded-sm px-2 py-1 text-left tabular-nums transition-colors hover:bg-gold-soft ${
              item.needsReview ? "font-medium text-warn" : "text-ink"
            }`}
            title="Klikni da izmeniš cenu"
          >
            {Number(item.price).toFixed(2)}{" "}
            <span className="text-xs font-normal text-ink/60">RSD</span>
          </button>
        )}
      </td>

      {/* Station */}
      <td className="px-4 py-2.5">
        {item.preparationStation !== "NONE" ? (
          <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-medium ${STATION_BADGE[item.preparationStation]}`}>
            {STATION_LABEL[item.preparationStation]}
          </span>
        ) : (
          <span className="text-xs text-ink/50">—</span>
        )}
      </td>

      {/* Available */}
      <td className="px-4 py-2.5 text-center">
        <input
          type="checkbox"
          checked={item.isAvailable}
          onChange={() => toggleAvailable(item)}
          className="cursor-pointer accent-gold"
          title="Dostupno (na stoku)"
        />
      </td>

      {/* Active */}
      <td className="px-4 py-2.5 text-center">
        <input
          type="checkbox"
          checked={item.isActive}
          onChange={() => toggleActive(item)}
          className="cursor-pointer accent-gold"
          title="Aktivno (vidljivo na meniju)"
        />
      </td>

      {/* Inventory tracking method — P1.6: nikad izvedeno iz kategorije, po artiklu. */}
      <td className="px-4 py-2.5">
        {canManageRecipes ? (
          <select
            className="w-full rounded-sm border border-line bg-transparent px-1.5 py-1 text-xs text-ink/75 focus:outline-none hover:border-ink/30"
            value={item.inventoryTrackingMethod}
            onChange={(e) => setTrackingMethod(item, e.target.value as MenuItem["inventoryTrackingMethod"])}
          >
            {(Object.keys(TRACKING_METHOD_LABEL) as MenuItem["inventoryTrackingMethod"][]).map((m) => (
              <option key={m} value={m}>{TRACKING_METHOD_LABEL[m]}</option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-ink/60">{TRACKING_METHOD_LABEL[item.inventoryTrackingMethod]}</span>
        )}
        {item.inventoryTrackingMethod === "RECIPE" && (
          <p className="mt-0.5 text-[10px] text-ink/50">Uredi sastojke preko dugmeta &quot;Normativ&quot;</p>
        )}
        {item.inventoryTrackingMethod === "DIRECT_STOCK" && (
          <a href="/inventory" className="mt-0.5 block text-[10px] text-gold-dark hover:underline">Upravljaj zalihama →</a>
        )}
      </td>

      {/* Move to category */}
      <td className="px-4 py-2.5">
        <select
          className="w-full rounded-sm border border-line bg-transparent px-1.5 py-1 text-xs text-ink/75 focus:outline-none hover:border-ink/30"
          value={item.categoryId ?? ""}
          onChange={(e) => moveToCategory(item.id, e.target.value)}
        >
          <option value="">Nekategorisano</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </td>

      {/* Actions */}
      <td className="px-4 py-2.5">
        <div className="flex gap-2 text-xs">
          <RecipeButton item={item} readOnly={!canManageRecipes} onChanged={refresh} />
          <button
            onClick={() => duplicateItem(item.id)}
            className="text-ink/65 transition-colors hover:text-ink"
            title="Napravi kopiju"
          >
            Kopiraj
          </button>
          <button
            onClick={() => archiveItem(item.id)}
            className="text-ink/65 transition-colors hover:text-ink"
            title="Arhiviraj"
          >
            Arh.
          </button>
          <button
            onClick={() => deleteItem(item.id)}
            className="text-danger/60 transition-colors hover:text-danger"
            title="Trajno obriši"
          >
            Obriši
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── AddItemForm ───────────────────────────────────────────────────────────────

function AddItemForm({
  categories,
  onClose,
  onCreated,
  setError,
}: {
  categories: Category[];
  onClose: () => void;
  onCreated: () => Promise<void>;
  setError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [station, setStation] = useState<MenuItem["preparationStation"]>("KITCHEN");
  const [saving, setSaving] = useState(false);

  function slugify(input: string) {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9čćšžđ\s-]/g, "")
      .replace(/[čć]/g, "c")
      .replace(/š/g, "s")
      .replace(/ž/g, "z")
      .replace(/đ/g, "dj")
      .replace(/\s+/g, "-");
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/menu/items`, {
        method: "POST",
        body: JSON.stringify({
          name,
          slug: slugify(name),
          price: Number(price),
          categoryId: categoryId || null,
          preparationStation: station,
        }),
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju artikla");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/20" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-md border border-line bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-ink">Novi artikal</h2>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/70">Naziv</label>
            <input
              autoFocus
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/70">Cena (RSD)</label>
            <input
              type="number"
              min="0"
              step="10"
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/70">Kategorija</label>
            <select
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Nekategorisano</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/70">Stanica</label>
            <select
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
              value={station}
              onChange={(e) => setStation(e.target.value as MenuItem["preparationStation"])}
            >
              <option value="KITCHEN">Kuhinja</option>
              <option value="BAR">Šank</option>
              <option value="KITCHEN_AND_BAR">Kuhinja + Šank</option>
              <option value="NONE">—</option>
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-sm px-3 py-1.5 text-sm text-ink/70 hover:bg-ink/5">
            Otkaži
          </button>
          <button
            onClick={submit}
            disabled={saving || !name || !price}
            className="rounded-sm bg-gold px-4 py-1.5 text-sm font-medium text-white hover:bg-gold-dark transition-colors disabled:opacity-40"
          >
            {saving ? "Čuvanje…" : "Sačuvaj"}
          </button>
        </div>
      </div>
    </div>
  );
}
