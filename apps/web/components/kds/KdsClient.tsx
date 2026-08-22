"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { LogoutButton } from "../ui/LogoutButton";
import { AppLogo } from "../branding/AppLogo";
import { TicketPrintPanel, type TicketContent } from "../printing/TicketPrintPanel";
import { fetchPrintJobs, printAndConfirm, type PrintJob } from "../../lib/print-client";

interface StationItemModifier {
  id: string;
  optionName: string;
  priceDelta: string;
}
interface StationItem {
  id: string;
  name: string;
  quantity: number;
  note: string | null;
  status: "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  modifiers: StationItemModifier[];
}

/** Dodaci moraju biti odmah uočljivi na KDS-u (specifikacija #16/#52) — "+"
 * prefiks se određuje po CENI (priceDelta > 0), ne parsiranjem naziva. */
function ModifierList({ modifiers, tone }: { modifiers: StationItemModifier[]; tone: "active" | "completed" }) {
  if (modifiers.length === 0) return null;
  return (
    <ul className={`mt-1 space-y-0.5 border-l-2 pl-2 ${tone === "active" ? "border-gold/50" : "border-white/10"}`}>
      {modifiers.map((m) => (
        <li key={m.id} className={`text-xs font-semibold ${tone === "active" ? "text-gold" : "text-cream-300/60"}`}>
          {Number(m.priceDelta) > 0 ? `+ ${m.optionName}` : m.optionName}
        </li>
      ))}
    </ul>
  );
}
interface StationOrder {
  orderId: string;
  tableLabel: string;
  waiterName: string;
  submittedAt: string | null;
  items: StationItem[];
}
interface CompletedOrder extends StationOrder {
  completedAt: string;
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

export function KdsClient({ station, title }: { station: "KITCHEN" | "BAR"; title: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "completed">("active");
  const [orders, setOrders] = useState<StationOrder[]>([]);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const knownOrderIds = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [printBusyId, setPrintBusyId] = useState<string | null>(null);
  const [pendingPrint, setPendingPrint] = useState<{ orderId: string; job: PrintJob } | null>(null);

  const baseEndpoint = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";

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
      // Audio nije podržan/dozvoljen u ovom browseru — tiho preskoči
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
      const [activeRes, completedRes] = await Promise.all([
        apiFetch(`${baseEndpoint}?locationId=${loc}`),
        apiFetch(`${baseEndpoint}/completed?locationId=${loc}`),
      ]);
      const newOrders: StationOrder[] = activeRes.orders;

      const newIds = newOrders.map((o) => o.orderId).filter((id) => !knownOrderIds.current.has(id));
      if (newIds.length > 0 && knownOrderIds.current.size > 0) beep();
      knownOrderIds.current = new Set(newOrders.map((o) => o.orderId));

      setOrders(newOrders);
      setCompletedOrders(completedRes.orders);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseEndpoint, locationId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  async function advance(orderId: string, itemId: string, expectedStatus: StationItem["status"]) {
    try {
      await apiFetch(`/api/production/items/${orderId}/${itemId}/advance`, {
        method: "POST",
        body: JSON.stringify({ station, expectedStatus }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function handlePrintTicket(orderId: string) {
    setPrintBusyId(orderId);
    setError(null);
    try {
      const jobs = await fetchPrintJobs(orderId);
      const job = jobs.find((j) => j.station === station);
      if (!job) {
        setError("Nema tiketa za štampu za ovu porudžbinu");
        return;
      }
      setPendingPrint({ orderId, job });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju tiketa");
    } finally {
      setPrintBusyId(null);
    }
  }

  useEffect(() => {
    if (!pendingPrint) return;
    printAndConfirm(pendingPrint.orderId, pendingPrint.job.id)
      .catch((e) => setError(e instanceof Error ? e.message : "Greška pri štampi"))
      .finally(() => setPendingPrint(null));
  }, [pendingPrint]);

  const isBar = station === "BAR";
  const accentClass = isBar ? "text-sky-300/70" : "text-amber-300/70";
  const tabActiveClass = isBar ? "bg-sky-500 text-white" : "bg-gold text-white";
  const tabCompletedClass = "bg-success text-white";

  return (
    <div className={`min-h-screen p-3 sm:p-5 ${isBar ? "bg-[#071b2b]" : "bg-graphite-900"}`}>
      <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" theme="dark" size="sm" />
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-[.2em] ${accentClass}`}>TableCore · produkcija</p>
            <h1 className="text-2xl font-bold tracking-tight text-cream-100">{title}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-white/10 bg-white/[.05] px-3 py-2 text-xs font-semibold tabular-nums text-cream-300/80">
            {orders.length} aktivnih
          </span>
          <LogoutButton theme="dark" />
        </div>
      </div>

      {/* Tab strip */}
      <div className="mb-5 flex gap-2">
        <button
          type="button"
          onClick={() => setTab("active")}
          className={`flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "active" ? tabActiveClass : "bg-white/[.07] text-cream-300/70 hover:bg-white/[.11]"
          }`}
        >
          Aktivne
          {orders.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
              tab === "active" ? "bg-white/25 text-white" : "bg-white/10 text-cream-300/80"
            }`}>
              {orders.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("completed")}
          className={`flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "completed" ? tabCompletedClass : "bg-white/[.07] text-cream-300/70 hover:bg-white/[.11]"
          }`}
        >
          Gotove
          {completedOrders.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
              tab === "completed" ? "bg-white/25 text-white" : "bg-white/10 text-cream-300/80"
            }`}>
              {completedOrders.length}
            </span>
          )}
        </button>
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : tab === "active" ? (
        orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <p className="text-lg font-medium text-cream-100">Nema aktivnih porudžbina</p>
            <p className="text-sm text-cream-300/70">Nove porudžbine će se automatski pojaviti ovde.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {orders.map((order) => {
              const waitMin = minutesSince(order.submittedAt);
              const isLate = waitMin >= 12;
              return (
                <div
                  key={order.orderId}
                  className={`overflow-hidden rounded-lg border bg-graphite-700 shadow-[0_12px_28px_rgba(0,0,0,.22)] ${
                    isLate ? "border-warn" : "border-graphite-700"
                  }`}
                >
                  <div className="flex items-center justify-between border-b border-white/10 bg-black/10 px-4 py-3">
                    <div>
                      <div className="text-xl font-bold tracking-tight text-cream-100">{order.tableLabel}</div>
                      <div className="mt-0.5 text-xs font-medium text-cream-300/70">Konobar · {order.waiterName}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md px-2.5 py-1 text-xs font-bold tabular-nums ${isLate ? "bg-warn text-white" : "bg-graphite-800 text-cream-300/80"}`}>
                        {waitMin} min
                      </span>
                      <button
                        type="button"
                        onClick={() => handlePrintTicket(order.orderId)}
                        disabled={printBusyId === order.orderId}
                        title="Štampaj tiket"
                        aria-label="Štampaj tiket"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-graphite-800 text-cream-300/80 hover:bg-graphite-900 disabled:opacity-40"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" /></svg>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2 p-3">
                    {order.items.map((item) => (
                      <div key={item.id} className="rounded-md border border-white/[.06] bg-graphite-800 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-base font-semibold leading-snug text-cream-100">
                              {item.quantity}× {item.name}
                            </div>
                            <ModifierList modifiers={item.modifiers} tone="active" />
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
                            onClick={() => advance(order.orderId, item.id, item.status)}
                            className="mt-3 min-h-11 w-full rounded-md bg-gold py-2 text-sm font-bold text-white transition-all hover:bg-gold-dark active:translate-y-px disabled:opacity-40"
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
        )
      ) : (
        completedOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <p className="text-lg font-medium text-cream-100">Nema završenih porudžbina u ovoj smeni</p>
            <p className="text-sm text-cream-300/70">Završene porudžbine će se automatski pojaviti ovde.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {completedOrders.map((order) => (
              <div
                key={order.orderId}
                className="overflow-hidden rounded-lg border border-success/20 bg-graphite-700/60 shadow-[0_8px_18px_rgba(0,0,0,.18)]"
              >
                <div className="flex items-center justify-between border-b border-white/[.06] bg-success/[.07] px-4 py-3">
                  <div>
                    <div className="text-xl font-bold tracking-tight text-cream-100">{order.tableLabel}</div>
                    <div className="mt-0.5 text-xs font-medium text-cream-300/60">Konobar · {order.waiterName}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-success/20 px-2.5 py-1 text-xs font-bold tabular-nums text-success">
                      {formatTime(order.completedAt)}
                    </span>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  </div>
                </div>

                <div className="space-y-1.5 p-3">
                  {order.items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-md border border-white/[.04] bg-graphite-800/60 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold leading-snug text-cream-100/70">
                          {item.quantity}× {item.name}
                        </div>
                        <ModifierList modifiers={item.modifiers} tone="completed" />
                        {item.note && (
                          <div className="mt-0.5 text-xs italic text-cream-300/50">
                            {item.note}
                          </div>
                        )}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        item.status === "CANCELLED"
                          ? "bg-danger/15 text-danger"
                          : "bg-success/15 text-success"
                      }`}>
                        {item.status === "CANCELLED" ? "Stornirano" : "Gotovo"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {pendingPrint && <TicketPrintPanel content={pendingPrint.job.content as TicketContent} />}
    </div>
  );
}
