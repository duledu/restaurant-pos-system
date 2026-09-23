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

// Mirrors inventory-client.tsx's OPENING_STOCK_ROLES — same
// 'inventory.opening_stock' server grant (OWNER/ADMIN only, deliberately
// stricter than 'inventory.manage'). UX-only gate; server is the real
// authorization boundary.
const OPENING_STOCK_ROLES = new Set(["OWNER", "ADMIN"]);

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

// ─── Bulk opening-stock modal (go-live: many ingredients at once) ──────────
//
// Ingredient-side counterpart to inventory-client.tsx's OpeningStockModal —
// same "edit -> confirm -> apply" flow, same OPENING_STOCK ledger semantics
// (server: bulkSetIngredientOpeningStock). Before this, raw ingredients
// only had one-row-at-a-time "Postavi početno stanje" per ingredient
// (StockPanel above) — realistic for a handful of items, not for entering
// 100+ ingredients at restaurant go-live. Bottom-sheet on mobile (someone
// standing in storage counting bottles), centered dialog on desktop.

function IngredientOpeningStockModal({
  locationId,
  onClose,
  onDone,
}: {
  locationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [allIngredients, setAllIngredients] = useState<Ingredient[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    itemsAffected: number;
    itemsUnchanged: number;
    results: Array<{ ingredientId: string; ingredientName: string; before: number; after: number; movementId: string | null }>;
  } | null>(null);

  useEffect(() => {
    if (!locationId) return;
    apiFetch(`/api/admin/ingredients?locationId=${locationId}&activeOnly=true`).then((j) => {
      const list: Ingredient[] = j.ingredients ?? [];
      setAllIngredients(list);
      // Pre-fill with CURRENT (test/dev) stock so a manager only has to
      // overtype the items whose real physical count differs — leaving a
      // value untouched posts no movement (before === after is a no-op
      // server-side), so this never silently "re-confirms" stale numbers.
      const initial: Record<string, string> = {};
      for (const i of list) {
        if (i.stock) initial[i.id] = fmtQty(Number(i.stock.currentStock));
      }
      setQuantities(initial);
    });
  }, [locationId]);

  const filtered = allIngredients.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
  const lines = allIngredients
    .filter((i) => quantities[i.id] !== undefined && quantities[i.id] !== "" && !isNaN(Number(quantities[i.id])))
    .map((i) => ({ ingredientId: i.id, ingredientName: i.name, unit: i.unit, quantity: Number(quantities[i.id]) }));

  function reviewStep() {
    if (!locationId) { setErr("Izaberite lokaciju"); return; }
    if (lines.length === 0) { setErr("Unesite bar jednu količinu"); return; }
    if (lines.some((l) => l.quantity < 0)) { setErr("Količina ne može biti negativna"); return; }
    setErr("");
    setStep("confirm");
  }

  async function apply() {
    setLoading(true); setErr("");
    try {
      const j = await apiFetch("/api/admin/ingredients/opening-stock", {
        method: "POST",
        body: JSON.stringify({
          locationId,
          lines: lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.quantity })),
          reason: "Postavljanje početnog stanja sirovina (go-live)",
        }),
      });
      setResult(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Greška");
    } finally {
      setLoading(false);
    }
  }

  const sheetClass = "fixed inset-0 z-50 flex items-end justify-center bg-graphite-900/50 sm:items-center sm:p-4";
  const panelClass = "flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-elevated sm:max-w-2xl sm:rounded-lg";

  if (result) {
    return (
      <div className={sheetClass} onClick={onClose}>
        <div className={panelClass} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6 sm:py-4">
            <h2 className="text-base font-semibold text-ink">Početno stanje sirovina postavljeno</h2>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            <p className="mb-3 text-sm text-ink">
              Izmenjeno: <strong>{result.itemsAffected}</strong> sirovina. Nepromenjeno (već na traženoj količini): {result.itemsUnchanged}.
            </p>
            <div className="mb-2 max-h-72 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-line bg-cream-200 text-left text-inkSoft"><th className="px-2 py-1.5 font-medium">Sirovina</th><th className="px-2 py-1.5 text-right font-medium">Pre</th><th className="px-2 py-1.5 text-right font-medium">Posle</th></tr></thead>
                <tbody>
                  {result.results.filter((r) => r.movementId).map((r) => (
                    <tr key={r.ingredientId} className="border-b border-line/60">
                      <td className="px-2 py-1 text-ink">{r.ingredientName}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums text-inkSoft">{fmtQty(r.before)}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-ink">{fmtQty(r.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="border-t border-line px-4 py-3 sm:px-6 sm:py-4">
            <Button onClick={() => { onClose(); onDone(); }} className="w-full">Zatvori</Button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className={sheetClass} onClick={onClose}>
        <div className={panelClass} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6 sm:py-4">
            <h2 className="text-base font-semibold text-ink">Potvrda — Postavi početno stanje sirovina</h2>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            <div className="mb-4 rounded-md bg-gold-soft px-3 py-3 text-sm text-gold-dark">
              Ova akcija je namenjena unosu stvarnog fizičkog stanja sirovina pre početka rada restorana.
              Svaka promena se beleži kao trajno kretanje zalihe (tip &quot;Početno stanje&quot;) — ništa se tiho ne prepisuje.
            </div>
            <p className="mb-2 text-sm text-inkSoft">
              Sirovina za izmenu: <strong className="text-ink">{lines.length}</strong>
            </p>
            <div className="mb-2 max-h-72 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-line bg-cream-200 text-left text-inkSoft"><th className="px-2 py-1.5 font-medium">Sirovina</th><th className="px-2 py-1.5 text-right font-medium">Nova količina</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.ingredientId} className="border-b border-line/60">
                      <td className="px-2 py-1 text-ink">{l.ingredientName}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-ink">{fmtQty(l.quantity)} {UNIT_LABELS[l.unit]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {err && <p className="mb-3 text-sm text-danger">{err}</p>}
          </div>
          <div className="flex gap-2 border-t border-line px-4 py-3 sm:px-6 sm:py-4">
            <Button variant="secondary" onClick={() => setStep("edit")} className="flex-1">Nazad</Button>
            <Button onClick={apply} disabled={loading} className="flex-1">
              {loading ? "Primena…" : "Potvrdi početno stanje"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={sheetClass} onClick={onClose}>
      <div className={panelClass} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6 sm:py-4">
          <h2 className="text-base font-semibold text-ink">Postavi početno stanje sirovina</h2>
          <button onClick={onClose} aria-label="Zatvori" className="flex h-11 w-11 items-center justify-center rounded-md text-ink/50 hover:bg-ink/[.05] hover:text-ink">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <p className="mb-3 text-sm text-inkSoft">
            Unesite stvarno fizičko stanje za svaku sirovinu pre nego što restoran počne da radi (npr. Juneće meso 12.4 kg, Konjak 2450 ml).
            Ovo ne briše prodaju ni istoriju. Postojeće vrednosti su unapred popunjene — izmenite samo ono što se razlikuje od stvarnog stanja.
          </p>
          <input
            type="search"
            inputMode="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pretraga sirovina…"
            className={`mb-3 ${inputClass}`}
          />
          <div className="mb-2 max-h-[50vh] overflow-y-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} className="border-b border-line/60">
                    <td className="px-2 py-2 text-ink">{i.name}</td>
                    <td className="px-2 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          value={quantities[i.id] ?? ""}
                          onChange={(e) => setQuantities((prev) => ({ ...prev, [i.id]: e.target.value }))}
                          className="w-20 rounded border border-line px-2 py-1.5 text-right text-sm"
                        />
                        <span className="w-7 text-left text-[11px] text-inkSoft">{UNIT_LABELS[i.unit]}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err && <p className="mb-2 text-sm text-danger">{err}</p>}
        </div>
        <div className="border-t border-line px-4 py-3 sm:px-6 sm:py-4">
          <Button onClick={reviewStep} className="w-full">
            Pregled i potvrda ({lines.length} {lines.length === 1 ? "sirovina" : "sirovina"})
          </Button>
        </div>
      </div>
    </div>
  );
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
  const [roles, setRoles] = useState<string[]>([]);
  const [showOpeningStock, setShowOpeningStock] = useState(false);
  const canOpeningStock = roles.some((r) => OPENING_STOCK_ROLES.has(r));

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
      // NE zovi load() ovde — samo postavi locationId. Efekat ispod već
      // reaguje na promenu locationId-a i pokreće load(); pozivanje odavde
      // TAKOĐE bi izazvalo DUPLI fetch iste liste sirovina na svaki dolazak
      // na stranicu (i direktan poziv ovde, i onaj iz efekta ispod, oba sa
      // istim efektivnim parametrima).
      setLocationId(locs[0]?.id ?? "");
    });
    apiFetch("/api/pos/me").then((j) => setRoles(j.roles ?? [])).catch(() => {});
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
            {canOpeningStock && (
              <Button size="sm" variant="secondary" onClick={() => setShowOpeningStock(true)} disabled={!locationId}>
                Početno stanje (grupno)
              </Button>
            )}
            <CreateIngredientForm categories={categories} onCreated={() => load(locationId, effectiveCategoryId)} />
          </>
        }
      />

      {showOpeningStock && (
        <IngredientOpeningStockModal
          locationId={locationId}
          onClose={() => setShowOpeningStock(false)}
          onDone={() => load(locationId, effectiveCategoryId)}
        />
      )}

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
