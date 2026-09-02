"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../../components/ui/QuickLockButton";

interface OrderItem {
  id: string;
  name: string;
  price: string;
  quantity: number;
  paidQuantity: number;
  status: string;
  modifiers: { optionName: string }[];
}
interface OrderData {
  id: string;
  locationId: string;
  items: OrderItem[];
  table: { label: string };
}
interface Table {
  id: string;
  label: string;
  status: "FREE" | "OCCUPIED" | "AWAITING_BILL" | "NEEDS_CLEANING";
  isActive?: boolean;
}
interface FloorWithTables {
  id: string;
  name: string;
  tables: Table[];
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function TransferClient({ tableId }: { tableId: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [floors, setFloors] = useState<FloorWithTables[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [destinationTableId, setDestinationTableId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const orderRes = await apiFetch("/api/pos/orders", { method: "POST", body: JSON.stringify({ tableId } ) });
      const orderId = orderRes.order.id;
      const orderDetail = await apiFetch(`/api/pos/orders/${orderId}`);
      setOrder(orderDetail.order);

      const tablesRes = await apiFetch(`/api/pos/tables?locationId=${orderDetail.order.locationId}`);
      setFloors(tablesRes.floors);
      setSelected({});
      setDestinationTableId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  useEffect(() => {
    load();
  }, [load]);

  const transferableItems = useMemo(
    () => (order ? order.items.filter((i) => i.status !== "CANCELLED" && i.quantity - i.paidQuantity > 0) : []),
    [order]
  );

  function setQuantity(itemId: string, remaining: number, qty: number) {
    const clamped = Math.max(0, Math.min(remaining, qty));
    setSelected((prev) => {
      const next = { ...prev };
      if (clamped === 0) delete next[itemId];
      else next[itemId] = clamped;
      return next;
    });
  }

  const selectedCount = Object.keys(selected).length;

  async function confirmTransfer() {
    if (!order || !destinationTableId || selectedCount === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/pos/orders/${order.id}/transfer`, {
        method: "POST",
        body: JSON.stringify({
          destinationTableId,
          lines: Object.entries(selected).map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        }),
      });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri prebacivanju stavki");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;

  if (done) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="rounded-md bg-success-soft px-4 py-3 text-sm font-medium text-success">Stavke su prebačene.</div>
        <button
          onClick={() => router.push("/waiter/tables")}
          className="w-full max-w-xs rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 transition-colors hover:bg-graphite-700"
        >
          Nazad na stolove
        </button>
      </div>
    );
  }

  if (!order) return <div className="p-6 text-danger">{error ?? "Porudžbina nije pronađena"}</div>;

  const destinationCandidates = floors.flatMap((f) => f.tables.filter((t) => t.id !== tableId && t.isActive !== false));

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <button onClick={() => router.push(`/waiter/tables/${tableId}`)} className="shrink-0 whitespace-nowrap text-sm font-medium text-gold-dark">
          ← Porudžbina
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold text-ink">{order.table.label} — Prebaci stavke</h1>
        <div className="flex shrink-0 items-center gap-1">
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>

      {error && <div className="mb-3 whitespace-pre-line rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {transferableItems.length === 0 ? (
        <div className="rounded-md border border-line bg-white p-4 text-center text-ink/70">Nema stavki dostupnih za transfer.</div>
      ) : (
        <>
          <div className="mb-2 text-sm font-medium text-inkSoft">Izaberi šta se prebacuje</div>
          <div className="space-y-2 rounded-md border border-line bg-white p-3">
            {transferableItems.map((item) => {
              const remaining = item.quantity - item.paidQuantity;
              const qty = selected[item.id] ?? 0;
              return (
                <div key={item.id} className="flex items-center gap-3 border-b border-line/50 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink" title={item.name}>{item.name}</div>
                    {item.modifiers.length > 0 && (
                      <div className="truncate text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                    )}
                    {item.paidQuantity > 0 && <div className="text-xs text-inkSoft">{item.paidQuantity} već plaćeno — ostaje na ovom stolu</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setQuantity(item.id, remaining, qty - 1)}
                      disabled={qty <= 0}
                      aria-label={`Umanji količinu za transfer — ${item.name}`}
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-12 text-center text-sm font-semibold tabular-nums text-ink">
                      {qty} <span className="font-normal text-inkSoft">/ {remaining}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuantity(item.id, remaining, qty + 1)}
                      disabled={qty >= remaining}
                      aria-label={`Povećaj količinu za transfer — ${item.name}`}
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-5">
            <div className="mb-2 text-sm font-medium text-inkSoft">Odredišni sto</div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {destinationCandidates.map((table) => (
                <button
                  key={table.id}
                  onClick={() => setDestinationTableId(table.id)}
                  className={`min-h-14 rounded-md border-2 px-2 py-2 text-sm font-semibold transition-colors ${
                    destinationTableId === table.id ? "border-gold bg-gold-soft text-gold-dark" : "border-line bg-white text-ink"
                  }`}
                >
                  {table.label}
                </button>
              ))}
              {destinationCandidates.length === 0 && <div className="col-span-full text-sm text-ink/55">Nema drugih stolova na ovoj lokaciji.</div>}
            </div>
          </div>

          {destinationTableId && (
            <div className="mt-4 flex items-center justify-center gap-2.5 rounded-md bg-gold-soft px-4 py-3 text-base font-bold text-gold-dark">
              <span>{order.table.label}</span>
              <span aria-hidden="true">→</span>
              <span>{destinationCandidates.find((t) => t.id === destinationTableId)?.label}</span>
            </div>
          )}

          <button
            onClick={confirmTransfer}
            disabled={!destinationTableId || selectedCount === 0 || submitting}
            className="mt-4 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 disabled:opacity-40 transition-colors hover:bg-graphite-700"
          >
            {submitting ? "Prebacivanje…" : "Potvrdi transfer"}
          </button>
        </>
      )}
    </div>
  );
}
