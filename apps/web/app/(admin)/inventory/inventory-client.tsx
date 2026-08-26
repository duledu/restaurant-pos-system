"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  slug: string;
  type: "FOOD" | "DRINK";
  sortOrder: number;
  isActive: boolean;
}

interface InventoryItem {
  id: string;
  currentStock: number;
  unit: string;
  menuItem: {
    id: string;
    name: string;
    unit: string | null;
    quantity: number | null;
    minimumStock: number | null;
    trackStock: boolean;
    // P1.3: da li artikal TRENUTNO ima konfigurisan normativ (bar jedna
    // MenuItemIngredient linija) — kad je true, sirovinski model UVEK
    // pobeđuje bez obzira na trackStock (isti obrazac kao
    // inventory-service.ts double-deduction odbrana). UI mora tretirati
    // stavku kao "efektivno praćenu" samo kad je trackStock && !hasRecipe.
    hasRecipe: boolean;
    categoryId: string | null;
    // P1.5: fizička kategorija ZALIHE (KUHINJA/ŠANK -> podkategorija) — samo
    // za organizaciju ove liste, NIKAD za odbitak (i dalje isključivo
    // trackStock/InventoryItem). Odvojeno od `categoryId` (MenuCategory).
    inventoryCategoryId: string | null;
    inventoryCategory: { id: string; name: string; parent: { id: string; name: string } | null } | null;
  };
  location: { id: string; name: string };
}

/** trackStock && !hasRecipe — jedina ispravna definicija "aktivno praćeno" (P1.3). */
function isEffectivelyTracked(item: InventoryItem) {
  return item.menuItem.trackStock && !item.menuItem.hasRecipe;
}

interface Movement {
  id: string;
  type: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reason: string | null;
  createdAt: string;
  employeeName?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const UNCAT = "__uncategorized__";

// ─── Formatters ───────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  INITIAL: "Inicijalizacija",
  OPENING_STOCK: "Početno stanje",
  RECEIPT: "Prijem robe",
  SALE: "Prodaja",
  ADJUSTMENT: "Korekcija",
  WRITE_OFF: "Otpis",
};

function fmtQty(n: number) {
  return n % 1 === 0 ? n.toString() : n.toFixed(3).replace(/\.?0+$/, "");
}

function stockStatus(item: InventoryItem): "out" | "low" | "ok" {
  if (item.currentStock <= 0) return "out";
  const min = item.menuItem.minimumStock;
  if (min != null && item.currentStock <= Number(min)) return "low";
  return "ok";
}

function isLowStock(item: InventoryItem) {
  return stockStatus(item) === "low";
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("sr-RS", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const inputClass =
  "w-full rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-ink/35";

// ─── TabPill ──────────────────────────────────────────────────────────────────

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
  count?: number;
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
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            dot === "food" ? "bg-success" : "bg-info"
          } ${active ? "opacity-60" : ""}`}
        />
      )}
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={`rounded-full px-1.5 tabular-nums text-[10px] ${
            active ? "bg-white/20 text-white" : "bg-ink/[0.07] text-ink/55"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-graphite-900/50 p-4" onClick={onClose}>
      <div
        className={`w-full animate-slide-up rounded-lg bg-white shadow-elevated ${wide ? "max-w-3xl" : "max-w-md"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button onClick={onClose} aria-label="Zatvori" className="flex h-11 w-11 items-center justify-center rounded-md text-ink/50 hover:bg-ink/[.05] hover:text-ink">✕</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

function ReceiveModal({ item, onClose, onDone }: { item: InventoryItem; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    const q = parseFloat(qty);
    if (!q || q <= 0) { setErr("Unesite pozitivnu količinu"); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/admin/inventory/${item.id}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: q, reason: reason || undefined }),
      });
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? "Greška"); return; }
      onDone();
    } finally { setLoading(false); }
  }

  return (
    <Modal title={`Primanje robe — ${item.menuItem.name}`} onClose={onClose}>
      <p className="mb-4 text-sm text-inkSoft">Trenutno stanje: <strong className="text-ink">{fmtQty(item.currentStock)} {item.unit}</strong></p>
      <label className="mb-1 block text-sm font-medium text-ink">Količina</label>
      <input type="number" min={0} step="any" value={qty} onChange={e => setQty(e.target.value)} className={`mb-3 ${inputClass}`} />
      <label className="mb-1 block text-sm font-medium text-ink">Napomena (opciono)</label>
      <input type="text" value={reason} onChange={e => setReason(e.target.value)} className={`mb-4 ${inputClass}`} />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button onClick={submit} loading={loading} className="w-full">
        {loading ? "Čuvanje…" : "Potvrdi prijem"}
      </Button>
    </Modal>
  );
}

function AdjustModal({ item, onClose, onDone }: { item: InventoryItem; onClose: () => void; onDone: () => void }) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [type, setType] = useState<"ADJUSTMENT" | "WRITE_OFF">("ADJUSTMENT");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    const d = parseFloat(delta);
    if (!d || d === 0) { setErr("Unesite količinu različitu od nule"); return; }
    if (!reason.trim()) { setErr("Razlog je obavezan"); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/admin/inventory/${item.id}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta: type === "WRITE_OFF" ? -Math.abs(d) : d, reason, type }),
      });
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? "Greška"); return; }
      onDone();
    } finally { setLoading(false); }
  }

  const adjustTitle = type === "WRITE_OFF" ? `Otpis — ${item.menuItem.name}` : `Korekcija — ${item.menuItem.name}`;
  return (
    <Modal title={adjustTitle} onClose={onClose}>
      <p className="mb-4 text-sm text-inkSoft">Trenutno stanje: <strong className="text-ink">{fmtQty(item.currentStock)} {item.unit}</strong></p>
      <div className="mb-3 flex gap-2">
        {(["ADJUSTMENT", "WRITE_OFF"] as const).map(t => (
          <button key={t} onClick={() => setType(t)}
            className={`flex-1 rounded-md border py-1.5 text-sm font-medium transition-colors ${type === t ? "border-gold bg-gold-soft text-gold-dark" : "border-line text-inkSoft hover:bg-cream-300/40"}`}>
            {t === "ADJUSTMENT" ? "Korekcija" : "Otpis"}
          </button>
        ))}
      </div>
      <label className="mb-1 block text-sm font-medium text-ink">Količina</label>
      <input type="number" min={0} step="any" value={delta} onChange={e => setDelta(e.target.value)} className={`mb-3 ${inputClass}`} />
      <label className="mb-1 block text-sm font-medium text-ink">Razlog *</label>
      <input type="text" value={reason} onChange={e => setReason(e.target.value)} className={`mb-4 ${inputClass}`} />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button onClick={submit} loading={loading} className="w-full">
        {loading ? "Čuvanje…" : "Potvrdi"}
      </Button>
    </Modal>
  );
}

function ThresholdModal({ item, onClose, onDone }: { item: InventoryItem; onClose: () => void; onDone: () => void }) {
  const current = item.menuItem.minimumStock;
  const [value, setValue] = useState(current != null ? fmtQty(Number(current)) : "");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function save(minimumStock: number | null) {
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/admin/inventory/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minimumStock }),
      });
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? "Greška"); return; }
      onDone();
    } finally { setLoading(false); }
  }

  function submit() {
    const trimmed = value.trim();
    if (trimmed === "") {
      // Namerno se prazno polje NE tretira kao "ukloni prag" — to mora biti
      // eksplicitna akcija (dugme ispod), da slučajno brisanje sadržaja
      // polja ne bi tiho izbrisalo prag.
      setErr('Unesite vrednost praga, ili koristite "Ukloni prag" ispod.');
      return;
    }
    const n = parseFloat(trimmed);
    if (isNaN(n) || n < 0) { setErr("Prag mora biti broj ≥ 0"); return; }
    save(n);
  }

  return (
    <Modal title={`Prag niske zalihe — ${item.menuItem.name}`} onClose={onClose}>
      <p className="mb-4 text-sm text-inkSoft">
        Trenutno stanje: <strong className="text-ink">{fmtQty(item.currentStock)} {item.unit}</strong>
        {" · "}
        Trenutni prag: <strong className="text-ink">{current != null ? `${fmtQty(Number(current))} ${item.unit}` : "Prag nije podešen"}</strong>
      </p>
      <label className="mb-1 block text-sm font-medium text-ink">Novi prag ({item.unit})</label>
      <input type="number" min={0} step="any" value={value} onChange={e => setValue(e.target.value)} className={`mb-4 ${inputClass}`} placeholder="npr. 5" />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <Button variant="dangerGhost" onClick={() => save(null)} loading={loading} className="flex-1">
          Ukloni prag
        </Button>
        <Button onClick={submit} loading={loading} className="flex-1">
          {loading ? "Čuvanje…" : "Sačuvaj"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * P1.5: dodeljuje INVENTORY (fizičku, KUHINJA/ŠANK) kategoriju direct-stock
 * artiklu (npr. Coca-Cola -> ŠANK -> Sokovi) — čisto organizaciono, NIKAD
 * ne utiče na trackStock/currentStock/odbitak (i dalje isključivo
 * InventoryItem, nepromenjeno).
 */
function CategoryAssignModal({
  item,
  categories,
  onClose,
  onDone,
}: {
  item: InventoryItem;
  categories: { id: string; name: string; parentId: string | null; isActive: boolean }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(item.menuItem.inventoryCategoryId ?? "");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const active = categories.filter((c) => c.isActive);
  const byId = new Map(active.map((c) => [c.id, c]));

  async function save() {
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/admin/menu/items/${item.menuItem.id}/inventory-category`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inventoryCategoryId: value || null }),
      });
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? "Greška"); return; }
      onDone();
    } finally { setLoading(false); }
  }

  return (
    <Modal title={`Kategorija zaliha — ${item.menuItem.name}`} onClose={onClose}>
      <p className="mb-3 text-xs text-inkSoft">Organizuje ovaj artikal pod KUHINJA/ŠANK na listi zaliha — ne menja stanje niti odbitak pri prodaji.</p>
      <select className={`mb-4 ${inputClass}`} value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Nekategorisano</option>
        {active
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => {
            const parent = c.parentId ? byId.get(c.parentId) : null;
            return (
              <option key={c.id} value={c.id}>
                {parent ? `${parent.name} / ${c.name}` : c.name}
              </option>
            );
          })}
      </select>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button onClick={save} loading={loading} className="w-full">{loading ? "Čuvanje…" : "Sačuvaj"}</Button>
    </Modal>
  );
}

function MovementsModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/inventory/${item.id}/movements`)
      .then(r => r.json())
      .then(j => setMovements(j.movements ?? []))
      .finally(() => setLoading(false));
  }, [item.id]);

  return (
    <Modal title={`Historija zaliha — ${item.menuItem.name}`} onClose={onClose} wide>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : movements.length === 0 ? (
        <EmptyState title="Nema kretanja" description="Ovaj artikal još nema zabeleženu istoriju zaliha." />
      ) : (
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-line text-left text-inkSoft">
                <th className="pb-1.5 pr-3 font-medium">Datum</th>
                <th className="pb-1.5 pr-3 font-medium">Tip</th>
                <th className="pb-1.5 pr-2 text-right font-medium">Δ</th>
                <th className="pb-1.5 pr-2 text-right font-medium">Pre</th>
                <th className="pb-1.5 pr-3 text-right font-medium">Posle</th>
                <th className="pb-1.5 pr-3 font-medium">Zaposleni</th>
                <th className="pb-1.5 font-medium">Razlog</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id} className="border-b border-line/60 hover:bg-cream-200/40">
                  <td className="py-1.5 pr-3 text-inkSoft whitespace-nowrap">{fmtDate(m.createdAt)}</td>
                  <td className="py-1.5 pr-3 font-medium text-ink whitespace-nowrap">{TYPE_LABELS[m.type] ?? m.type}</td>
                  <td className={`py-1.5 pr-2 text-right font-mono tabular-nums ${Number(m.quantityDelta) >= 0 ? "text-success" : "text-danger"}`}>
                    {Number(m.quantityDelta) >= 0 ? "+" : ""}{fmtQty(Number(m.quantityDelta))}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-inkSoft">{fmtQty(Number(m.quantityBefore))}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-ink font-semibold">{fmtQty(Number(m.quantityAfter))}</td>
                  <td className="py-1.5 pr-3 text-inkSoft whitespace-nowrap">{m.employeeName ?? "—"}</td>
                  <td className="max-w-[180px] truncate py-1.5 text-inkSoft">{m.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ─── Initialize modal ─────────────────────────────────────────────────────────

interface MenuItemOption { id: string; name: string; unit: string | null }
interface LocationOption { id: string; name: string }

/**
 * Recipe-produced items are managed through Ingredients + Normativi, not
 * initialized as finished-goods stock — excludes any MenuItem with a
 * configured recipe from the candidate list. Purely a UX filter on the
 * candidate pool; never touches any existing InventoryItem/InventoryMovement
 * row (a stale/legacy one, if it exists from before a recipe was added,
 * stays fully intact and remains visible via "Prikaži isključene" + its
 * "Historija" button on the main Zalihe list).
 */
async function fetchDirectStockCandidates(): Promise<MenuItemOption[]> {
  const [itemsRes, recipesRes] = await Promise.all([
    fetch("/api/admin/menu/items").then((r) => r.json()),
    fetch("/api/admin/recipes").then((r) => r.json()),
  ]);
  const configuredIds = new Set<string>(
    (recipesRes.items ?? []).filter((r: { isConfigured: boolean }) => r.isConfigured).map((r: { id: string }) => r.id)
  );
  return (itemsRes.items ?? []).filter((m: MenuItemOption) => !configuredIds.has(m.id));
}

function InitModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [menuItemId, setMenuItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [initialStock, setInitialStock] = useState("0");
  const [unit, setUnit] = useState("kom");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchDirectStockCandidates().then(setMenuItems);
    fetch("/api/admin/locations").then(r => r.json()).then(j => setLocations(j.locations ?? []));
  }, []);

  async function submit() {
    if (!menuItemId) { setErr("Izaberite artikal"); return; }
    if (!locationId) { setErr("Izaberite lokaciju"); return; }
    const stock = parseFloat(initialStock);
    if (isNaN(stock) || stock < 0) { setErr("Početno stanje mora biti ≥ 0"); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/admin/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId, locationId, initialStock: stock, unit }),
      });
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? "Greška"); return; }
      onDone();
    } finally { setLoading(false); }
  }

  return (
    <Modal title="Praćenje zaliha — inicijalizacija" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink">Artikal</label>
      <select value={menuItemId} onChange={e => setMenuItemId(e.target.value)} className={`mb-3 ${inputClass}`}>
        <option value="">— Izaberite —</option>
        {menuItems.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <label className="mb-1 block text-sm font-medium text-ink">Lokacija</label>
      <select value={locationId} onChange={e => setLocationId(e.target.value)} className={`mb-3 ${inputClass}`}>
        <option value="">— Izaberite —</option>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <div className="mb-3 flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium text-ink">Početno stanje</label>
          <input type="number" min={0} step="any" value={initialStock} onChange={e => setInitialStock(e.target.value)} className={inputClass} />
        </div>
        <div className="w-24">
          <label className="mb-1 block text-sm font-medium text-ink">Jedinica</label>
          <input type="text" value={unit} onChange={e => setUnit(e.target.value)} placeholder="kom" className={inputClass} />
        </div>
      </div>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button onClick={submit} loading={loading} className="w-full">
        {loading ? "Čuvanje…" : "Inicijalizuj praćenje"}
      </Button>
    </Modal>
  );
}

// ─── Go-live: bulk opening-stock initialization / reset ───────────────────────
//
// OWNER/ADMIN only (server-enforced via 'inventory.opening_stock' — hiding
// these buttons for other roles is UX only, not the security boundary).
// Two-step confirmation by design: this can rewrite every tracked item's
// stock in one call, so a single accidental click must not be enough.

interface OpeningStockResult {
  itemsAffected: number;
  itemsUnchanged: number;
  results: Array<{ menuItemId: string; menuItemName: string; before: number; after: number; movementId: string | null }>;
}

function OpeningStockModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [fillValue, setFillValue] = useState("30");
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OpeningStockResult | null>(null);

  useEffect(() => {
    fetchDirectStockCandidates().then(setMenuItems);
    fetch("/api/admin/locations").then(r => r.json()).then(j => {
      const locs: LocationOption[] = j.locations ?? [];
      setLocations(locs);
      if (locs.length > 0) setLocationId(locs[0].id);
    });
  }, []);

  function fillEmpty() {
    const v = fillValue.trim();
    if (v === "" || isNaN(Number(v)) || Number(v) < 0) return;
    setQuantities(prev => {
      const next = { ...prev };
      for (const m of menuItems) {
        if (next[m.id] === undefined || next[m.id] === "") next[m.id] = v;
      }
      return next;
    });
  }

  const filteredItems = menuItems.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
  const lines = menuItems
    .filter(m => quantities[m.id] !== undefined && quantities[m.id] !== "" && !isNaN(Number(quantities[m.id])))
    .map(m => ({ menuItemId: m.id, menuItemName: m.name, quantity: Number(quantities[m.id]) }));

  function reviewStep() {
    if (!locationId) { setErr("Izaberite lokaciju"); return; }
    if (lines.length === 0) { setErr("Unesite bar jednu količinu"); return; }
    if (lines.some(l => l.quantity < 0)) { setErr("Količina ne može biti negativna"); return; }
    setErr("");
    setStep("confirm");
  }

  async function apply() {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/admin/inventory/opening-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          lines: lines.map(l => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
          reason: "Postavljanje početnog stanja zaliha (go-live)",
        }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? "Greška"); return; }
      setResult(j);
    } finally { setLoading(false); }
  }

  if (result) {
    return (
      <Modal title="Početno stanje postavljeno" onClose={() => { onClose(); onDone(); }}>
        <p className="mb-3 text-sm text-ink">
          Izmenjeno: <strong>{result.itemsAffected}</strong> artikala. Nepromenjeno (već na traženoj količini): {result.itemsUnchanged}.
        </p>
        <div className="mb-4 max-h-60 overflow-y-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-line bg-cream-200 text-left text-inkSoft"><th className="px-2 py-1.5 font-medium">Artikal</th><th className="px-2 py-1.5 text-right font-medium">Pre</th><th className="px-2 py-1.5 text-right font-medium">Posle</th></tr></thead>
            <tbody>
              {result.results.filter(r => r.movementId).map(r => (
                <tr key={r.menuItemId} className="border-b border-line/60">
                  <td className="px-2 py-1 text-ink">{r.menuItemName}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-inkSoft">{fmtQty(r.before)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-ink">{fmtQty(r.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button onClick={() => { onClose(); onDone(); }} className="w-full">Zatvori</Button>
      </Modal>
    );
  }

  if (step === "confirm") {
    const locationName = locations.find(l => l.id === locationId)?.name ?? "";
    return (
      <Modal title="Potvrda — Postavi početno stanje zaliha" onClose={onClose}>
        <div className="mb-4 rounded-md bg-gold-soft px-3 py-3 text-sm text-gold-dark">
          Ova akcija je namenjena početnom unosu stvarnog stanja zaliha pre početka rada restorana.
          Neće obrisati prodaju, porudžbine, račune ili istoriju poslovanja. Svaka promena se beleži
          kao trajno kretanje zalihe (tip &quot;Početno stanje&quot;) — ništa se tiho ne prepisuje.
        </div>
        <p className="mb-2 text-sm text-inkSoft">
          Lokacija: <strong className="text-ink">{locationName}</strong> &middot; Artikala za izmenu: <strong className="text-ink">{lines.length}</strong>
        </p>
        <div className="mb-4 max-h-60 overflow-y-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-line bg-cream-200 text-left text-inkSoft"><th className="px-2 py-1.5 font-medium">Artikal</th><th className="px-2 py-1.5 text-right font-medium">Nova količina</th></tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.menuItemId} className="border-b border-line/60">
                  <td className="px-2 py-1 text-ink">{l.menuItemName}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-ink">{fmtQty(l.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {err && <p className="mb-3 text-sm text-danger">{err}</p>}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setStep("edit")} className="flex-1">Nazad</Button>
          <Button onClick={apply} loading={loading} className="flex-1">
            {loading ? "Primena…" : "Potvrdi i primeni"}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Postavi početno stanje zaliha" onClose={onClose}>
      <p className="mb-3 text-sm text-inkSoft">
        Unesite stvarno stanje za svaki artikal pre nego što restoran počne da radi. Ovo ne briše prodaju ni istoriju.
      </p>
      <label className="mb-1 block text-sm font-medium text-ink">Lokacija</label>
      <select value={locationId} onChange={e => setLocationId(e.target.value)} className={`mb-3 ${inputClass}`}>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>

      <div className="mb-3 flex gap-2">
        <input type="number" min={0} step="any" value={fillValue} onChange={e => setFillValue(e.target.value)} className={`w-24 ${inputClass}`} />
        <Button variant="secondary" size="md" onClick={fillEmpty} className="whitespace-nowrap">
          Popuni prazne količinom
        </Button>
      </div>

      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Pretraga artikala…" className={`mb-3 ${inputClass}`} />

      <div className="mb-3 max-h-72 overflow-y-auto rounded-md border border-line">
        <table className="w-full text-xs">
          <tbody>
            {filteredItems.map(m => (
              <tr key={m.id} className="border-b border-line/60">
                <td className="px-2 py-1.5 text-ink">{m.name}</td>
                <td className="px-2 py-1.5 text-right">
                  <input type="number" min={0} step="any"
                    value={quantities[m.id] ?? ""}
                    onChange={e => setQuantities(prev => ({ ...prev, [m.id]: e.target.value }))}
                    className="w-20 rounded border border-line px-2 py-1 text-right text-xs" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button onClick={reviewStep} className="w-full">
        Pregled i potvrda ({lines.length} {lines.length === 1 ? "artikal" : "artikala"})
      </Button>
    </Modal>
  );
}

function ZeroAllModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OpeningStockResult | null>(null);

  useEffect(() => {
    fetch("/api/admin/locations").then(r => r.json()).then(j => {
      const locs: LocationOption[] = j.locations ?? [];
      setLocations(locs);
      if (locs.length > 0) setLocationId(locs[0].id);
    });
  }, []);

  async function apply() {
    if (confirmText.trim().toUpperCase() !== "RESETUJ") { setErr('Ukucajte "RESETUJ" da potvrdite'); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/admin/inventory/opening-stock/zero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? "Greška"); return; }
      setResult(j);
    } finally { setLoading(false); }
  }

  if (result) {
    return (
      <Modal title="Zalihe resetovane na 0" onClose={() => { onClose(); onDone(); }}>
        <p className="mb-4 text-sm text-ink">
          Resetovano na 0: <strong>{result.itemsAffected}</strong> artikala. Kretanja zaliha (istorija) su sačuvana — ništa nije obrisano.
        </p>
        <Button onClick={() => { onClose(); onDone(); }} className="w-full">Zatvori</Button>
      </Modal>
    );
  }

  return (
    <Modal title="Postavi sve zalihe na 0" onClose={onClose}>
      <div className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-3 text-sm text-danger">
        Ovo postavlja stanje SVIH trenutno praćenih artikala na ovoj lokaciji na 0 — namenjeno uklanjanju
        privremenih test-količina pre unosa stvarnog početnog stanja. Ne briše prodaju, porudžbine, račune
        ni istoriju kretanja zaliha; svaka promena se beleži kao auditabilno kretanje.
      </div>
      <label className="mb-1 block text-sm font-medium text-ink">Lokacija</label>
      <select value={locationId} onChange={e => setLocationId(e.target.value)} className={`mb-4 ${inputClass}`}>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <label className="mb-1 block text-sm font-medium text-ink">Ukucajte &quot;RESETUJ&quot; da potvrdite</label>
      <input type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)} className={`mb-4 ${inputClass}`} />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <Button variant="danger" onClick={apply} loading={loading} className="w-full">
        {loading ? "Primena…" : "Resetuj sve na 0"}
      </Button>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type ModalState =
  | { type: "receive"; item: InventoryItem }
  | { type: "adjust"; item: InventoryItem }
  | { type: "movements"; item: InventoryItem }
  | { type: "threshold"; item: InventoryItem }
  | { type: "category"; item: InventoryItem }
  | { type: "init" }
  | { type: "opening-stock" }
  | { type: "zero-all" }
  | null;

type StatusFilter = "all" | "low" | "out";

const OPENING_STOCK_ROLES = new Set(["OWNER", "ADMIN"]);

export function InventoryClient() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // P1.5: fizička (KUHINJA/ŠANK) kategorija zaliha — NAMERNO odvojena
  // promenljiva od `categories` (MenuCategory) iznad, da se ne pomešaju.
  const [inventoryCategoryOptions, setInventoryCategoryOptions] = useState<{ id: string; name: string; parentId: string | null; isActive: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState("");
  const [activeCategoryTab, setActiveCategoryTab] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roles, setRoles] = useState<string[]>([]);
  // P1.3: podrazumevano SAKRIVA recepturisane/isključene stavke (više nisu
  // "prodajna" zaliha) — istorija ostaje potpuno dostupna preko ovog
  // prekidača + "Historija" dugmeta po redu, nikad se ne briše.
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/inventory")
      .then(r => r.json())
      .then(j => setItems(j.items ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/admin/menu/categories")
      .then(r => r.json())
      .then(j => setCategories(j.categories ?? []))
      .catch(() => {});
    fetch("/api/admin/inventory-categories")
      .then(r => r.json())
      .then(j => setInventoryCategoryOptions(j.categories ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Read-only — used ONLY to decide whether to show the go-live buttons.
    // Real authorization is server-side (inventory.opening_stock), enforced
    // again on every request regardless of what this renders.
    fetch("/api/pos/me").then(r => r.json()).then(j => setRoles(j.roles ?? [])).catch(() => {});
  }, []);
  const canOpeningStock = roles.some(r => OPENING_STOCK_ROLES.has(r));

  function closeAndRefresh() { setModal(null); load(); }

  // Per-category item count (before search — counts stay stable while typing)
  const categoryCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = item.menuItem.categoryId ?? UNCAT;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const uncategorizedCount = categoryCount.get(UNCAT) ?? 0;

  // Combined search + category + status + tracking filter (AND). P1.3: a
  // recipe-produced (or otherwise disabled) item is hidden from the default
  // view — it no longer represents sellable finished stock, only historical
  // record — unless "Prikaži isključene" is explicitly toggled on.
  const filtered = useMemo(() => {
    return items.filter(it => {
      const matchesSearch =
        it.menuItem.name.toLowerCase().includes(search.toLowerCase()) ||
        it.location.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory =
        activeCategoryTab === null ||
        (activeCategoryTab === UNCAT
          ? it.menuItem.categoryId === null
          : it.menuItem.categoryId === activeCategoryTab);
      const matchesTracking = showInactive || isEffectivelyTracked(it);
      const matchesStatus =
        statusFilter === "all" || (isEffectivelyTracked(it) && stockStatus(it) === statusFilter);
      return matchesSearch && matchesCategory && matchesTracking && matchesStatus;
    });
  }, [items, search, activeCategoryTab, statusFilter, showInactive]);

  const trackedItems = items.filter(isEffectivelyTracked);
  const outOfStockCount = trackedItems.filter(i => stockStatus(i) === "out").length;
  const lowStockCount = trackedItems.filter(i => stockStatus(i) === "low").length;
  const inactiveCount = items.length - trackedItems.length;

  function selectTab(id: string | null) {
    setActiveCategoryTab(prev => (prev === id ? null : id));
  }

  // ─── Empty state copy ────────────────────────────────────────────────────────
  let emptyTitle = "Nema rezultata pretrage";
  let emptyDescription: string | undefined;
  if (items.length === 0) {
    emptyTitle = "Nema inicijalizovanih stavki zaliha";
    emptyDescription = 'Kliknite "+ Inicijalizuj stavku" da počnete praćenje prve stavke.';
  } else if (!search && activeCategoryTab !== null) {
    emptyTitle = "U ovoj kategoriji nema artikala sa zalihama.";
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Zalihe"
        description="Praćenje stanja zaliha po artiklima i lokacijama"
        actions={
          <>
            {canOpeningStock && (
              <>
                <Button variant="dangerGhost" size="md" onClick={() => setModal({ type: "zero-all" })}>
                  Postavi sve na 0
                </Button>
                <Button variant="secondary" size="md" onClick={() => setModal({ type: "opening-stock" })}>
                  Postavi početno stanje
                </Button>
              </>
            )}
            <Button size="md" onClick={() => setModal({ type: "init" })}>
              + Inicijalizuj stavku
            </Button>
          </>
        }
      />

      {/* ── Search + status filter ───────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line/80 bg-white p-3 shadow-sm">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Pretraga artikala…" className={`max-w-sm ${inputClass}`} />
        <div className="flex gap-1.5">
          <TabPill active={statusFilter === "all"} onClick={() => setStatusFilter("all")} label="Sve" />
          <TabPill active={statusFilter === "low"} onClick={() => setStatusFilter("low")} label="Niska zaliha" count={lowStockCount} />
          <TabPill active={statusFilter === "out"} onClick={() => setStatusFilter("out")} label="Nema na stanju" count={outOfStockCount} />
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs font-medium text-inkSoft">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Prikaži isključene/istorijske stavke ({inactiveCount})
        </label>
      </div>

      {/* ── Category tab strip (same pattern as Menu) ────────────────────────── */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-0.5">
        <TabPill
          active={activeCategoryTab === null}
          onClick={() => setActiveCategoryTab(null)}
          label="Sve kategorije"
        />
        {categories.map(cat => (
          <TabPill
            key={cat.id}
            active={activeCategoryTab === cat.id}
            onClick={() => selectTab(cat.id)}
            label={cat.name}
            count={categoryCount.get(cat.id)}
            dot={cat.type === "FOOD" ? "food" : "drink"}
          />
        ))}
        <TabPill
          active={activeCategoryTab === UNCAT}
          onClick={() => selectTab(UNCAT)}
          label="Nekategorisano"
          count={uncategorizedCount}
        />
      </div>

      {loading ? (
        <Card className="p-5">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-5">
          <EmptyState title={emptyTitle} description={emptyDescription} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-cream-200 text-left text-xs font-semibold uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3">Artikal</th>
                  <th className="px-4 py-3">Lokacija</th>
                  <th className="px-4 py-3 text-right">Stanje</th>
                  <th className="px-4 py-3 text-right">Min. zaliha</th>
                  <th className="px-4 py-3 text-center">Praćenje</th>
                  <th className="px-4 py-3 text-right">Akcije</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {filtered.map(item => {
                  const effectivelyTracked = isEffectivelyTracked(item);
                  const status = effectivelyTracked ? stockStatus(item) : null;
                  const min = item.menuItem.minimumStock;
                  const rowCls =
                    status === "out" ? "bg-danger-soft/60 shadow-[inset_3px_0_0_#B91C1C]" :
                    status === "low" ? "bg-warn-soft/40 shadow-[inset_3px_0_0_#B45309]" :
                    !effectivelyTracked ? "opacity-60 hover:bg-cream-200/40" :
                    "hover:bg-cream-200/60";
                  const stockCls =
                    status === "out" ? "text-danger" :
                    status === "low" ? "text-warn" :
                    "text-ink";
                  return (
                    <tr key={item.id} className={rowCls}>
                      <td className="px-4 py-3">
                        <span className="block font-semibold text-ink">{item.menuItem.name}</span>
                        {status === "out" && <Badge tone="danger">Nema na zalihama</Badge>}
                        {status === "low" && <Badge tone="warn">Niska zaliha</Badge>}
                        {!effectivelyTracked && item.menuItem.hasRecipe && <Badge tone="gold">Normativ aktivan</Badge>}
                        {item.menuItem.inventoryCategory ? (
                          <Badge tone="neutral">
                            {item.menuItem.inventoryCategory.parent ? `${item.menuItem.inventoryCategory.parent.name} / ${item.menuItem.inventoryCategory.name}` : item.menuItem.inventoryCategory.name}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-inkSoft">{item.location.name}</td>
                      <td className={`px-4 py-3 text-right text-base font-bold tabular-nums ${stockCls}`}>
                        {fmtQty(item.currentStock)} {item.unit}
                        {!effectivelyTracked && <span className="ml-1 text-xs font-normal text-ink/40">(istorijsko)</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-inkSoft">
                        {min != null ? `${fmtQty(Number(min))} ${item.unit}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge tone={effectivelyTracked ? "success" : "neutral"}>
                          {effectivelyTracked ? "Aktivno" : item.menuItem.hasRecipe ? "Normativ (sirovine)" : "Isključeno"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5 whitespace-nowrap text-xs font-semibold">
                          <button onClick={() => setModal({ type: "receive", item })} className="min-h-11 rounded-md bg-gold-soft px-2.5 py-1.5 text-gold-dark hover:bg-gold/20">
                            Prijem
                          </button>
                          <button onClick={() => setModal({ type: "adjust", item })} className="min-h-11 rounded-md px-2.5 py-1.5 text-inkSoft hover:bg-ink/[.05] hover:text-ink">
                            Korekcija
                          </button>
                          <button onClick={() => setModal({ type: "movements", item })} className="min-h-11 rounded-md px-2.5 py-1.5 text-gold-dark hover:bg-gold-soft">
                            Historija
                          </button>
                          <button onClick={() => setModal({ type: "threshold", item })} className="min-h-11 rounded-md px-2.5 py-1.5 text-inkSoft hover:bg-ink/[.05] hover:text-ink">
                            Prag
                          </button>
                          <button onClick={() => setModal({ type: "category", item })} className="min-h-11 rounded-md px-2.5 py-1.5 text-inkSoft hover:bg-ink/[.05] hover:text-ink">
                            Kategorija
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {modal?.type === "receive"    && <ReceiveModal   item={modal.item} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "adjust"     && <AdjustModal    item={modal.item} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "movements"  && <MovementsModal item={modal.item} onClose={() => setModal(null)} />}
      {modal?.type === "threshold"  && <ThresholdModal  item={modal.item} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "category"   && <CategoryAssignModal item={modal.item} categories={inventoryCategoryOptions} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "init"       && <InitModal               onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "opening-stock" && canOpeningStock && <OpeningStockModal onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "zero-all"      && canOpeningStock && <ZeroAllModal      onClose={() => setModal(null)} onDone={closeAndRefresh} />}
    </div>
  );
}
