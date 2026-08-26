"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";

const UNITS = ["KILOGRAM", "GRAM", "LITER", "MILLILITER", "PIECE"] as const;
type Unit = (typeof UNITS)[number];
const UNIT_LABELS: Record<Unit, string> = { KILOGRAM: "kg", GRAM: "g", LITER: "l", MILLILITER: "ml", PIECE: "kom" };

interface Location {
  id: string;
  name: string;
}
interface Stock {
  id: string;
  currentStock: string;
  lowStockThreshold: string | null;
}
interface InventoryCategoryOption {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
}
interface Ingredient {
  id: string;
  name: string;
  unit: Unit;
  category: string | null;
  inventoryCategoryId: string | null;
  inventoryCategory: { id: string; name: string; parent: { id: string; name: string } | null } | null;
  sku: string | null;
  isActive: boolean;
  stock: Stock | null;
}
interface Movement {
  id: string;
  type: string;
  quantityDelta: string;
  quantityBefore: string;
  quantityAfter: string;
  reason: string | null;
  createdAt: string;
  employeeName?: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  OPENING_STOCK: "Početno stanje",
  RECEIPT: "Prijem robe",
  ADJUSTMENT: "Korekcija",
  WRITE_OFF: "Otpis",
  SALE: "Prodaja",
  INVENTORY_CORRECTION: "Popis",
  RETURN_TO_SUPPLIER: "Povraćaj dobavljaču",
};

function fmtQty(n: number) {
  return n % 1 === 0 ? n.toString() : n.toFixed(3).replace(/\.?0+$/, "");
}

// P1.7: NEGATIVE (currentStock < 0) je NAJJAČI status — evidentiran manjak,
// MORA odgovarati inventory-service.ts getInventoryStockStatus tačno.
function stockStatus(stock: Stock | null): "missing" | "negative" | "out" | "low" | "ok" {
  if (!stock) return "missing";
  const current = Number(stock.currentStock);
  if (current < 0) return "negative";
  if (current === 0) return "out";
  const threshold = stock.lowStockThreshold != null ? Number(stock.lowStockThreshold) : null;
  if (threshold != null && current <= threshold) return "low";
  return "ok";
}

const inputClass = "w-full rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-ink/35";

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Greška");
  return body;
}

// ─── Create ingredient form ─────────────────────────────────────────────────

/** Flat list -> grouped <option>s, "KUHINJA / Meso" style labels for subcategories, top-level categories shown too (assignable directly, e.g. general "KUHINJA" items). */
function CategorySelect({
  categories,
  value,
  onChange,
  className,
}: {
  categories: InventoryCategoryOption[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const active = categories.filter((c) => c.isActive);
  const byId = new Map(active.map((c) => [c.id, c]));
  return (
    <select className={className ?? inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Kategorija zaliha… (opciono)</option>
      {active
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((c) => {
          const parent = c.parentId ? byId.get(c.parentId) : null;
          return (
            <option key={c.id} value={c.id}>
              {parent ? `${parent.name} / ${c.name}` : c.name}
            </option>
          );
        })}
    </select>
  );
}

function CreateIngredientForm({ categories, onCreated }: { categories: InventoryCategoryOption[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Unit>("KILOGRAM");
  const [inventoryCategoryId, setInventoryCategoryId] = useState("");
  const [sku, setSku] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setErr("");
    if (!name.trim()) { setErr("Naziv je obavezan"); return; }
    setLoading(true);
    try {
      await apiFetch("/api/admin/ingredients", {
        method: "POST",
        body: JSON.stringify({ name, unit, inventoryCategoryId: inventoryCategoryId || undefined, sku: sku || undefined }),
      });
      setName(""); setInventoryCategoryId(""); setSku(""); setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Greška");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return <Button size="sm" onClick={() => setOpen(true)}>+ Nova sirovina</Button>;
  }

  return (
    <Card className="p-4">
      <p className="mb-3 text-sm font-semibold text-ink">Nova sirovina</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={inputClass} placeholder="Naziv (npr. Biftek)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          {UNITS.map((u) => (
            <option key={u} value={u}>{UNIT_LABELS[u]}</option>
          ))}
        </select>
        <CategorySelect categories={categories} value={inventoryCategoryId} onChange={setInventoryCategoryId} />
        <input className={inputClass} placeholder="Šifra (opciono)" value={sku} onChange={(e) => setSku(e.target.value)} />
      </div>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={submit} disabled={loading}>{loading ? "Čuvanje…" : "Sačuvaj"}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Otkaži</Button>
      </div>
    </Card>
  );
}

// ─── Stock panel (receive / adjust / write-off / movements / opening) ──────

function StockPanel({ ingredient, locationId, onChanged }: { ingredient: Ingredient; locationId: string; onChanged: () => void }) {
  const [mode, setMode] = useState<"none" | "opening" | "receive" | "adjust" | "writeoff" | "history">("none");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [threshold, setThreshold] = useState(ingredient.stock?.lowStockThreshold ?? "");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [movements, setMovements] = useState<Movement[]>([]);

  const unitLabel = UNIT_LABELS[ingredient.unit];

  async function loadMovements() {
    if (!ingredient.stock) return;
    const j = await apiFetch(`/api/admin/ingredient-stocks/${ingredient.stock.id}/movements`);
    setMovements(j.movements ?? []);
  }

  useEffect(() => {
    if (mode === "history") loadMovements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function submitOpening() {
    setErr("");
    const qty = Number(amount);
    if (!Number.isFinite(qty) || qty < 0) { setErr("Unesite ispravnu količinu"); return; }
    setLoading(true);
    try {
      await apiFetch(`/api/admin/ingredients/${ingredient.id}/stock`, {
        method: "POST",
        body: JSON.stringify({ locationId, initialStock: qty, lowStockThreshold: threshold !== "" ? Number(threshold) : undefined }),
      });
      setAmount(""); setMode("none"); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); } finally { setLoading(false); }
  }

  async function submitReceive() {
    if (!ingredient.stock) return;
    setErr("");
    const qty = Number(amount);
    if (!Number.isFinite(qty) || qty <= 0) { setErr("Unesite pozitivnu količinu"); return; }
    setLoading(true);
    try {
      await apiFetch(`/api/admin/ingredient-stocks/${ingredient.stock.id}/receive`, {
        method: "POST",
        body: JSON.stringify({ quantity: qty, reason: reason || undefined }),
      });
      setAmount(""); setReason(""); setMode("none"); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); } finally { setLoading(false); }
  }

  async function submitAdjustOrWriteOff(kind: "adjust" | "writeoff") {
    if (!ingredient.stock) return;
    setErr("");
    if (!reason.trim()) { setErr("Razlog je obavezan"); return; }
    setLoading(true);
    try {
      if (kind === "writeoff") {
        const qty = Number(amount);
        if (!Number.isFinite(qty) || qty <= 0) { setErr("Unesite pozitivnu količinu"); setLoading(false); return; }
        await apiFetch(`/api/admin/ingredient-stocks/${ingredient.stock.id}/write-off`, {
          method: "POST",
          body: JSON.stringify({ quantity: qty, reason }),
        });
      } else {
        const delta = Number(amount);
        if (!Number.isFinite(delta) || delta === 0) { setErr("Unesite ne-nula deltu (+ ili -)"); setLoading(false); return; }
        await apiFetch(`/api/admin/ingredient-stocks/${ingredient.stock.id}/adjust`, {
          method: "POST",
          body: JSON.stringify({ delta, reason }),
        });
      }
      setAmount(""); setReason(""); setMode("none"); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); } finally { setLoading(false); }
  }

  if (!ingredient.stock) {
    return mode === "opening" ? (
      <div className="mt-2 rounded-md border border-line bg-cream-100 p-3">
        <p className="mb-2 text-xs font-semibold text-ink">Početno stanje ({unitLabel})</p>
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} w-28`} type="number" step="0.001" placeholder="Količina" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={`${inputClass} w-28`} type="number" step="0.001" placeholder="Prag (opc.)" value={threshold as string} onChange={(e) => setThreshold(e.target.value)} />
          <Button size="sm" onClick={submitOpening} disabled={loading}>Sačuvaj</Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("none")}>Otkaži</Button>
        </div>
        {err && <p className="mt-1 text-xs text-danger">{err}</p>}
      </div>
    ) : (
      <Button size="sm" variant="secondary" onClick={() => setMode("opening")}>Postavi početno stanje</Button>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setMode(mode === "receive" ? "none" : "receive")}>Prijem</Button>
        <Button size="sm" variant="secondary" onClick={() => setMode(mode === "adjust" ? "none" : "adjust")}>Korekcija</Button>
        <Button size="sm" variant="secondary" onClick={() => setMode(mode === "writeoff" ? "none" : "writeoff")}>Otpis</Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(mode === "history" ? "none" : "history")}>Istorija</Button>
      </div>

      {mode === "receive" && (
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border border-line bg-cream-100 p-3">
          <input className={`${inputClass} w-28`} type="number" step="0.001" placeholder={`Količina (${unitLabel})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={inputClass} placeholder="Razlog (opc.)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" onClick={submitReceive} disabled={loading}>Sačuvaj</Button>
          {err && <p className="w-full text-xs text-danger">{err}</p>}
        </div>
      )}
      {mode === "adjust" && (
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border border-line bg-cream-100 p-3">
          <input className={`${inputClass} w-28`} type="number" step="0.001" placeholder="Delta (+/-)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={inputClass} placeholder="Razlog (obavezno)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" onClick={() => submitAdjustOrWriteOff("adjust")} disabled={loading}>Sačuvaj</Button>
          {err && <p className="w-full text-xs text-danger">{err}</p>}
        </div>
      )}
      {mode === "writeoff" && (
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border border-line bg-cream-100 p-3">
          <input className={`${inputClass} w-28`} type="number" step="0.001" placeholder={`Količina (${unitLabel})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={inputClass} placeholder="Razlog (obavezno)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" variant="danger" onClick={() => submitAdjustOrWriteOff("writeoff")} disabled={loading}>Otpiši</Button>
          {err && <p className="w-full text-xs text-danger">{err}</p>}
        </div>
      )}
      {mode === "history" && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-line bg-cream-100 p-2">
          {movements.length === 0 ? (
            <p className="p-2 text-xs text-inkSoft">Nema kretanja.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id} className="border-b border-line/50 last:border-0">
                    <td className="py-1 pr-2 text-inkSoft">{new Date(m.createdAt).toLocaleString("sr-RS")}</td>
                    <td className="py-1 pr-2">{TYPE_LABELS[m.type] ?? m.type}</td>
                    <td className={`py-1 pr-2 text-right tabular-nums ${Number(m.quantityDelta) < 0 ? "text-danger" : "text-success"}`}>
                      {Number(m.quantityDelta) > 0 ? "+" : ""}{fmtQty(Number(m.quantityDelta))}
                    </td>
                    <td className="py-1 pr-2 text-inkSoft">{m.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function IngredientRow({
  ingredient,
  locationId,
  categories,
  onChanged,
}: {
  ingredient: Ingredient;
  locationId: string;
  categories: InventoryCategoryOption[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ingredient.name);
  const [inventoryCategoryId, setInventoryCategoryId] = useState(ingredient.inventoryCategoryId ?? "");
  const [err, setErr] = useState("");

  const status = stockStatus(ingredient.stock);
  const statusBadge =
    status === "missing" ? <Badge>Nema stanja</Badge> :
    status === "negative" ? <Badge tone="dangerSolid">Negativna zaliha</Badge> :
    status === "out" ? <Badge tone="danger">Nema na stanju</Badge> :
    status === "low" ? <Badge tone="warn">Nisko stanje</Badge> :
    <Badge tone="success">OK</Badge>;

  async function saveEdit() {
    setErr("");
    try {
      await apiFetch(`/api/admin/ingredients/${ingredient.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, inventoryCategoryId: inventoryCategoryId || null }),
      });
      setEditing(false);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
  }

  async function toggleActive() {
    const path = ingredient.isActive ? "deactivate" : "activate";
    await apiFetch(`/api/admin/ingredients/${ingredient.id}/${path}`, { method: "POST" });
    onChanged();
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex flex-wrap gap-2">
              <input className={`${inputClass} w-48`} value={name} onChange={(e) => setName(e.target.value)} />
              <CategorySelect categories={categories} value={inventoryCategoryId} onChange={setInventoryCategoryId} className={`${inputClass} w-56`} />
              <Button size="sm" onClick={saveEdit}>Sačuvaj</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Otkaži</Button>
              {err && <p className="w-full text-xs text-danger">{err}</p>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-ink">{ingredient.name}</p>
              <Badge tone="gold">{UNIT_LABELS[ingredient.unit]}</Badge>
              {ingredient.inventoryCategory ? (
                <Badge>
                  {ingredient.inventoryCategory.parent ? `${ingredient.inventoryCategory.parent.name} / ${ingredient.inventoryCategory.name}` : ingredient.inventoryCategory.name}
                </Badge>
              ) : (
                <Badge tone="neutral">Nekategorisano</Badge>
              )}
              {!ingredient.isActive && <Badge tone="neutral">Neaktivna</Badge>}
              {statusBadge}
              {ingredient.stock && (
                <span className="text-sm tabular-nums text-inkSoft">
                  {fmtQty(Number(ingredient.stock.currentStock))} {UNIT_LABELS[ingredient.unit]}
                </span>
              )}
            </div>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Izmeni</Button>
            <Button size="sm" variant="ghost" onClick={toggleActive}>{ingredient.isActive ? "Deaktiviraj" : "Aktiviraj"}</Button>
          </div>
        )}
      </div>
      {!editing && <StockPanel ingredient={ingredient} locationId={locationId} onChanged={onChanged} />}
    </Card>
  );
}

// ─── TabPill ──────────────────────────────────────────────────────────────────

function TabPill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        active ? "border-gold bg-gold-soft text-gold-dark" : "border-line text-inkSoft hover:bg-cream-200/60"
      }`}
    >
      {label}
      {count !== undefined && <span className="text-[10px] opacity-70">{count}</span>}
    </button>
  );
}

// ─── Main client ─────────────────────────────────────────────────────────────

export function IngredientsClient() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [categories, setCategories] = useState<InventoryCategoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [activeTopId, setActiveTopId] = useState<string | null>(null);
  const [activeSubId, setActiveSubId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  // P1.7 audit §9: status filter (client-side over the already-loaded,
  // location-scoped list — same pattern as inventory-client.tsx Zalihe).
  const [statusFilter, setStatusFilter] = useState<"all" | "low" | "out" | "negative">("all");

  const loadCategories = useCallback(async () => {
    const j = await apiFetch("/api/admin/inventory-categories");
    setCategories(j.categories ?? []);
  }, []);

  const load = useCallback(async (loc: string, categoryId: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (loc) params.set("locationId", loc);
      if (search) params.set("search", search);
      if (!showInactive) params.set("activeOnly", "true");
      if (categoryId) params.set("inventoryCategoryId", categoryId);
      const j = await apiFetch(`/api/admin/ingredients?${params.toString()}`);
      setIngredients(j.ingredients ?? []);
    } finally {
      setLoading(false);
    }
  }, [search, showInactive]);

  const effectiveCategoryId = activeSubId ?? activeTopId;

  useEffect(() => {
    loadCategories();
    apiFetch("/api/admin/locations").then((j) => {
      const locs: Location[] = j.locations ?? [];
      setLocations(locs);
      const first = locs[0]?.id ?? "";
      setLocationId(first);
      load(first, null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (locationId) load(locationId, effectiveCategoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, search, showInactive, effectiveCategoryId]);

  async function seedDefaults() {
    setSeeding(true);
    try {
      await apiFetch("/api/admin/inventory-categories/seed-defaults", { method: "POST" });
      await loadCategories();
    } finally {
      setSeeding(false);
    }
  }

  const topCategories = categories.filter((c) => c.parentId === null && c.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  const subCategories = activeTopId
    ? categories.filter((c) => c.parentId === activeTopId && c.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  function selectTop(id: string | null) {
    setActiveTopId((prev) => (prev === id ? null : id));
    setActiveSubId(null);
  }

  const negativeCount = ingredients.filter((i) => stockStatus(i.stock) === "negative").length;
  const outCount = ingredients.filter((i) => stockStatus(i.stock) === "out").length;
  const lowCount = ingredients.filter((i) => stockStatus(i.stock) === "low").length;
  const filteredIngredients = statusFilter === "all" ? ingredients : ingredients.filter((i) => stockStatus(i.stock) === statusFilter);

  return (
    <div>
      <PageHeader
        title="Sirovine / Zalihe"
        description="Fizička zaliha sirovina (KUHINJA / ŠANK) za normative (recepture) — odvojeno od zaliha gotovih artikala i od menija."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={seedDefaults} disabled={seeding}>
              {seeding ? "Podešavanje…" : "Podesi KUHINJA/ŠANK kategorije"}
            </Button>
            <CreateIngredientForm categories={categories} onCreated={() => load(locationId, effectiveCategoryId)} />
          </>
        }
      />

      {topCategories.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <TabPill active={activeTopId === null} onClick={() => selectTop(null)} label="Sve kategorije" />
          {topCategories.map((c) => (
            <TabPill key={c.id} active={activeTopId === c.id} onClick={() => selectTop(c.id)} label={c.name} />
          ))}
        </div>
      )}
      {subCategories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5 border-l-2 border-line/60 pl-2">
          <TabPill active={activeSubId === null} onClick={() => setActiveSubId(null)} label={`Sve (${topCategories.find((c) => c.id === activeTopId)?.name ?? ""})`} />
          {subCategories.map((c) => (
            <TabPill key={c.id} active={activeSubId === c.id} onClick={() => setActiveSubId((prev) => (prev === c.id ? null : c.id))} label={c.name} />
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className={`${inputClass} w-56`} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <input className={`${inputClass} w-56`} placeholder="Pretraga…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-1.5 text-xs text-inkSoft">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Prikaži neaktivne
        </label>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <TabPill active={statusFilter === "all"} onClick={() => setStatusFilter("all")} label="Sve" />
        <TabPill active={statusFilter === "low"} onClick={() => setStatusFilter("low")} label="Niska zaliha" count={lowCount} />
        <TabPill active={statusFilter === "out"} onClick={() => setStatusFilter("out")} label="Nema na stanju" count={outCount} />
        <TabPill active={statusFilter === "negative"} onClick={() => setStatusFilter("negative")} label="Negativna zaliha" count={negativeCount} />
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : filteredIngredients.length === 0 ? (
        <EmptyState title="Nema sirovina" description="Dodajte prvu sirovinu da biste mogli da definišete normative." />
      ) : (
        <div className="space-y-2">
          {filteredIngredients.map((i) => (
            <IngredientRow key={i.id} ingredient={i} locationId={locationId} categories={categories} onChanged={() => load(locationId, effectiveCategoryId)} />
          ))}
        </div>
      )}
    </div>
  );
}
