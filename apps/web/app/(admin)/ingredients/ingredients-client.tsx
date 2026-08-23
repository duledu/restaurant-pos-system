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
interface Ingredient {
  id: string;
  name: string;
  unit: Unit;
  category: string | null;
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

function stockStatus(stock: Stock | null): "missing" | "out" | "low" | "ok" {
  if (!stock) return "missing";
  const current = Number(stock.currentStock);
  if (current <= 0) return "out";
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

function CreateIngredientForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<Unit>("KILOGRAM");
  const [category, setCategory] = useState("");
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
        body: JSON.stringify({ name, unit, category: category || undefined, sku: sku || undefined }),
      });
      setName(""); setCategory(""); setSku(""); setOpen(false);
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
        <input className={inputClass} placeholder="Naziv (npr. Mleveno meso)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          {UNITS.map((u) => (
            <option key={u} value={u}>{UNIT_LABELS[u]}</option>
          ))}
        </select>
        <input className={inputClass} placeholder="Kategorija (opciono, npr. Meso)" value={category} onChange={(e) => setCategory(e.target.value)} />
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

function IngredientRow({ ingredient, locationId, onChanged }: { ingredient: Ingredient; locationId: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ingredient.name);
  const [category, setCategory] = useState(ingredient.category ?? "");
  const [err, setErr] = useState("");

  const status = stockStatus(ingredient.stock);
  const statusBadge =
    status === "missing" ? <Badge>Nema stanja</Badge> :
    status === "out" ? <Badge tone="danger">Nema na stanju</Badge> :
    status === "low" ? <Badge tone="warn">Nisko stanje</Badge> :
    <Badge tone="success">OK</Badge>;

  async function saveEdit() {
    setErr("");
    try {
      await apiFetch(`/api/admin/ingredients/${ingredient.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, category: category || null }),
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
              <input className={`${inputClass} w-40`} placeholder="Kategorija" value={category} onChange={(e) => setCategory(e.target.value)} />
              <Button size="sm" onClick={saveEdit}>Sačuvaj</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Otkaži</Button>
              {err && <p className="w-full text-xs text-danger">{err}</p>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-ink">{ingredient.name}</p>
              <Badge tone="gold">{UNIT_LABELS[ingredient.unit]}</Badge>
              {ingredient.category && <Badge>{ingredient.category}</Badge>}
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

// ─── Main client ─────────────────────────────────────────────────────────────

export function IngredientsClient() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async (loc: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (loc) params.set("locationId", loc);
      if (search) params.set("search", search);
      if (!showInactive) params.set("activeOnly", "true");
      const j = await apiFetch(`/api/admin/ingredients?${params.toString()}`);
      setIngredients(j.ingredients ?? []);
    } finally {
      setLoading(false);
    }
  }, [search, showInactive]);

  useEffect(() => {
    apiFetch("/api/admin/locations").then((j) => {
      const locs: Location[] = j.locations ?? [];
      setLocations(locs);
      const first = locs[0]?.id ?? "";
      setLocationId(first);
      load(first);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (locationId) load(locationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, search, showInactive]);

  return (
    <div>
      <PageHeader
        title="Sirovine"
        description="Sirovinski lager za normative (recepture) — odvojeno od zaliha gotovih artikala."
        actions={<CreateIngredientForm onCreated={() => load(locationId)} />}
      />

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

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : ingredients.length === 0 ? (
        <EmptyState title="Nema sirovina" description="Dodajte prvu sirovinu da biste mogli da definišete normative." />
      ) : (
        <div className="space-y-2">
          {ingredients.map((i) => (
            <IngredientRow key={i.id} ingredient={i} locationId={locationId} onChanged={() => load(locationId)} />
          ))}
        </div>
      )}
    </div>
  );
}
