"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface StationItem {
  id: string;
  name: string;
  quantity: number;
  note: string | null;
  status: "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
}
interface StationOrder {
  orderId: string;
  tableLabel: string;
  waiterName: string;
  submittedAt: string | null;
  items: StationItem[];
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Novo",
  ACCEPTED: "Prihvaćeno",
  PREPARING: "U pripremi",
  READY: "Spremno",
};

const STATUS_ACTION_LABEL: Record<string, string> = {
  SUBMITTED: "Prihvati",
  ACCEPTED: "Počni pripremu",
  PREPARING: "Označi spremno",
  READY: "Preuzeto",
};

const STATUS_BADGE: Record<string, string> = {
  SUBMITTED: "bg-gold-soft text-gold-dark",
  ACCEPTED: "bg-gold text-white",
  PREPARING: "bg-warn text-white",
  READY: "bg-success text-white",
};

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

export function KdsClient({ station, title }: { station: "KITCHEN" | "BAR"; title: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [orders, setOrders] = useState<StationOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);

  const endpoint = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";

  function beep() {
    try {
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch {
      // Audio nije podržan/dozvoljen u ovom browseru — tiho preskoči, ne
      // sme blokirati rad kuhinje.
    }
  }

  const load = useCallback(async () => {
    try {
      let loc = locationId;
      if (!loc) {
        const me = await apiFetch("/api/pos/me");
        loc = me.locationIds[0];
        setLocationId(loc);
      }
      const res = await apiFetch(`${endpoint}?locationId=${loc}`);
      const newOrders: StationOrder[] = res.orders;

      const newIds = newOrders.map((o) => o.orderId).filter((id) => !knownOrderIds.current.has(id));
      if (newIds.length > 0 && knownOrderIds.current.size > 0) beep();
      knownOrderIds.current = new Set(newOrders.map((o) => o.orderId));

      setOrders(newOrders);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, locationId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000); // MVP: polling na 4s dok SSE potrošnja na KDS-u nije ožičena
    return () => clearInterval(interval);
  }, [load]);

  async function advance(orderId: string, itemId: string) {
    try {
      await apiFetch(`/api/production/items/${orderId}/${itemId}/advance`, {
        method: "POST",
        body: JSON.stringify({ station }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  return (
    <div className="min-h-screen p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-cream-100">{title}</h1>
        <span className="text-xs text-cream-300/70">{orders.length} aktivnih porudžbina</span>
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
          <p className="text-lg font-medium text-cream-100">Nema aktivnih porudžbina</p>
          <p className="text-sm text-cream-300/70">Nove porudžbine će se automatski pojaviti ovde.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => {
            const waitMin = minutesSince(order.submittedAt);
            const isLate = waitMin >= 12;
            return (
              <div
                key={order.orderId}
                className={`rounded-lg border-2 bg-graphite-700 p-4 shadow-elevated ${
                  isLate ? "border-warn" : "border-graphite-700"
                }`}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-lg font-bold text-cream-100">{order.tableLabel}</div>
                    <div className="text-xs text-cream-300/70">{order.waiterName}</div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${isLate ? "bg-warn text-white" : "bg-graphite-800 text-cream-300/70"}`}>
                    {waitMin} min
                  </span>
                </div>

                <div className="space-y-2">
                  {order.items.map((item) => (
                    <div key={item.id} className="rounded-sm bg-graphite-800 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium text-cream-100">
                            {item.quantity}× {item.name}
                          </div>
                          {item.note && (
                            <div className="mt-0.5 text-xs italic text-cream-300/70">
                              {item.note}
                            </div>
                          )}
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[item.status] ?? "bg-graphite text-cream-100"}`}>
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </div>
                      {STATUS_ACTION_LABEL[item.status] && (
                        <button
                          onClick={() => advance(order.orderId, item.id)}
                          className="mt-2 w-full rounded-sm bg-gold py-2 text-sm font-semibold text-white active:scale-95 hover:bg-gold-dark transition-colors"
                        >
                          {STATUS_ACTION_LABEL[item.status]}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
