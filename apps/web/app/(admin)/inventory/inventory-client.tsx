"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  };
  location: { id: string; name: string };
}

interface Movement {
  id: string;
  type: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reason: string | null;
  createdAt: string;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  INITIAL: "Inicijalizacija",
  OPENING_STOCK: "Početno stanje",
  RECEIPT: "Primanje robe",
  SALE: "Prodaja",
  ADJUSTMENT: "Korekcija",
  WRITE_OFF: "Otpis",
};

function fmtQty(n: number) {
  return n % 1 === 0 ? n.toString() : n.toFixed(3).replace(/\.?0+$/, "");
}

function isLowStock(item: InventoryItem) {
  const min = item.menuItem.minimumStock;
  return min != null && item.currentStock <= Number(min);
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
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
      <p className="mb-4 text-sm text-gray-500">Trenutno stanje: <strong>{fmtQty(item.currentStock)} {item.unit}</strong></p>
      <label className="mb-1 block text-sm font-medium">Količina</label>
      <input type="number" min={0} step="any" value={qty} onChange={e => setQty(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
      <label className="mb-1 block text-sm font-medium">Napomena (opciono)</label>
      <input type="text" value={reason} onChange={e => setReason(e.target.value)}
        className="mb-4 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <button onClick={submit} disabled={loading}
        className="w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
        {loading ? "Čuvanje..." : "Potvrdi prijem"}
      </button>
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

  return (
    <Modal title={`Korekcija — ${item.menuItem.name}`} onClose={onClose}>
      <p className="mb-4 text-sm text-gray-500">Trenutno stanje: <strong>{fmtQty(item.currentStock)} {item.unit}</strong></p>
      <div className="mb-3 flex gap-2">
        {(["ADJUSTMENT", "WRITE_OFF"] as const).map(t => (
          <button key={t} onClick={() => setType(t)}
            className={`flex-1 rounded-lg border py-1.5 text-sm font-medium ${type === t ? "border-amber-500 bg-amber-50 text-amber-700" : "text-gray-500 hover:bg-gray-50"}`}>
            {t === "ADJUSTMENT" ? "Korekcija" : "Otpis"}
          </button>
        ))}
      </div>
      <label className="mb-1 block text-sm font-medium">Količina</label>
      <input type="number" min={0} step="any" value={delta} onChange={e => setDelta(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
      <label className="mb-1 block text-sm font-medium">Razlog *</label>
      <input type="text" value={reason} onChange={e => setReason(e.target.value)}
        className="mb-4 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <button onClick={submit} disabled={loading}
        className="w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
        {loading ? "Čuvanje..." : "Potvrdi"}
      </button>
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
    <Modal title={`Historija — ${item.menuItem.name}`} onClose={onClose}>
      {loading ? (
        <p className="text-sm text-gray-400">Učitavanje...</p>
      ) : movements.length === 0 ? (
        <p className="text-sm text-gray-400">Nema kretanja.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="pb-1 pr-2">Tip</th>
                <th className="pb-1 pr-2 text-right">Δ</th>
                <th className="pb-1 pr-2 text-right">Posle</th>
                <th className="pb-1">Razlog</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id} className="border-b border-gray-50">
                  <td className="py-1.5 pr-2 font-medium">{TYPE_LABELS[m.type] ?? m.type}</td>
                  <td className={`py-1.5 pr-2 text-right font-mono ${Number(m.quantityDelta) >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {Number(m.quantityDelta) >= 0 ? "+" : ""}{fmtQty(Number(m.quantityDelta))}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmtQty(Number(m.quantityAfter))}</td>
                  <td className="py-1.5 text-gray-500 truncate max-w-[120px]">{m.reason ?? "—"}</td>
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
    fetch("/api/admin/menu/items").then(r => r.json()).then(j => setMenuItems(j.items ?? []));
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
      <label className="mb-1 block text-sm font-medium">Artikal</label>
      <select value={menuItemId} onChange={e => setMenuItemId(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
        <option value="">— Izaberite —</option>
        {menuItems.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <label className="mb-1 block text-sm font-medium">Lokacija</label>
      <select value={locationId} onChange={e => setLocationId(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
        <option value="">— Izaberite —</option>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <div className="mb-3 flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-sm font-medium">Početno stanje</label>
          <input type="number" min={0} step="any" value={initialStock} onChange={e => setInitialStock(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
        </div>
        <div className="w-24">
          <label className="mb-1 block text-sm font-medium">Jedinica</label>
          <input type="text" value={unit} onChange={e => setUnit(e.target.value)} placeholder="kom"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
        </div>
      </div>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <button onClick={submit} disabled={loading}
        className="w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
        {loading ? "Čuvanje..." : "Inicijalizuj praćenje"}
      </button>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type ModalState =
  | { type: "receive"; item: InventoryItem }
  | { type: "adjust"; item: InventoryItem }
  | { type: "movements"; item: InventoryItem }
  | { type: "init" }
  | null;

export function InventoryClient() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/inventory")
      .then(r => r.json())
      .then(j => setItems(j.items ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function closeAndRefresh() { setModal(null); load(); }

  const filtered = items.filter(it =>
    it.menuItem.name.toLowerCase().includes(search.toLowerCase()) ||
    it.location.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Zalihe</h1>
          <p className="text-sm text-gray-500 mt-0.5">Praćenje stanja zaliha po artiklima i lokacijama</p>
        </div>
        <button onClick={() => setModal({ type: "init" })}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">
          + Inicijalizuj stavku
        </button>
      </div>

      {/* Search */}
      <input type="search" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Pretraga artikala..." className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />

      {/* Table */}
      {loading ? (
        <p className="text-sm text-gray-400">Učitavanje...</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-16 text-center">
          <p className="text-gray-400 text-sm">
            {items.length === 0
              ? "Nema inicijalizovanih stavki zaliha. Kliknite \"+ Inicijalizuj stavku\" da počnete."
              : "Nema rezultata pretrage."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100 shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Artikal</th>
                <th className="px-4 py-3 text-left">Lokacija</th>
                <th className="px-4 py-3 text-right">Stanje</th>
                <th className="px-4 py-3 text-right">Min. zaliha</th>
                <th className="px-4 py-3 text-center">Praćenje</th>
                <th className="px-4 py-3 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(item => {
                const low = isLowStock(item);
                const min = item.menuItem.minimumStock;
                return (
                  <tr key={item.id} className={`hover:bg-gray-50/50 ${low ? "bg-red-50/40" : ""}`}>
                    <td className="px-4 py-3">
                      <span className="font-medium">{item.menuItem.name}</span>
                      {low && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">Niska zaliha</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{item.location.name}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">
                      {fmtQty(item.currentStock)} {item.unit}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      {min != null ? `${fmtQty(Number(min))} ${item.unit}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${item.menuItem.trackStock ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {item.menuItem.trackStock ? "Aktivno" : "Isključeno"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setModal({ type: "receive", item })}
                          className="rounded px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">
                          Prijem
                        </button>
                        <button onClick={() => setModal({ type: "adjust", item })}
                          className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100">
                          Korekcija
                        </button>
                        <button onClick={() => setModal({ type: "movements", item })}
                          className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50">
                          Historija
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {modal?.type === "receive"    && <ReceiveModal   item={modal.item} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "adjust"     && <AdjustModal    item={modal.item} onClose={() => setModal(null)} onDone={closeAndRefresh} />}
      {modal?.type === "movements"  && <MovementsModal item={modal.item} onClose={() => setModal(null)} />}
      {modal?.type === "init"       && <InitModal               onClose={() => setModal(null)} onDone={closeAndRefresh} />}
    </div>
  );
}
