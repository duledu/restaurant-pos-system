"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../../components/ui/QuickLockButton";

interface PreviewItem {
  orderItemId: string;
  name: string;
  unitPrice: string;
  quantity: number;
  paidQuantity: number;
  remaining: number;
  modifiers: { optionName: string; priceDelta: string }[];
}
interface PreviewPayment {
  id: string;
  method: "CASH" | "CARD";
  amount: string;
  isSplit: boolean;
  completedAt: string;
}
interface Preview {
  orderId: string;
  tableLabel: string;
  fullyPaid: boolean;
  hasUnsentDraftItems: boolean;
  items: PreviewItem[];
  remainingSubtotal: string;
  remainingTax: string;
  payments: PreviewPayment[];
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const PAYMENT_LABEL: Record<"CASH" | "CARD", string> = { CASH: "Gotovina", CARD: "Kartica" };

export function SplitBillClient({ tableId }: { tableId: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<"CASH" | "CARD" | null>(null);
  const [tendered, setTendered] = useState("");
  const [paying, setPaying] = useState(false);
  const [lastPaidAmount, setLastPaidAmount] = useState<string | null>(null);

  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const orderRes = await apiFetch("/api/pos/orders", { method: "POST", body: JSON.stringify({ tableId }) });
      const orderId = orderRes.order.id;
      const previewRes: Preview = await apiFetch(`/api/pos/orders/${orderId}/split-bill`);
      setPreview(previewRes);
      setSelected({});
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

  function setQuantity(itemId: string, remaining: number, qty: number) {
    const clamped = Math.max(0, Math.min(remaining, qty));
    setSelected((prev) => {
      const next = { ...prev };
      if (clamped === 0) delete next[itemId];
      else next[itemId] = clamped;
      return next;
    });
  }

  const selectedLines = useMemo(
    () => (preview ? preview.items.filter((i) => (selected[i.orderItemId] ?? 0) > 0) : []),
    [preview, selected]
  );
  const selectedSubtotal = useMemo(
    () => selectedLines.reduce((sum, i) => sum + Number(i.unitPrice) * (selected[i.orderItemId] ?? 0), 0),
    [selectedLines, selected]
  );
  // Napomena: ovo je informativna procena (bez PDV/prorata popusta) — server
  // (paySplitBill) uvek presuđuje tačan iznos naplate iz OrderItem snapshot-a.
  const change = useMemo(() => {
    const t = Number(tendered);
    if (!tendered || Number.isNaN(t) || t < selectedSubtotal) return null;
    return t - selectedSubtotal;
  }, [tendered, selectedSubtotal]);

  async function confirmPayment() {
    if (!preview || !method || selectedLines.length === 0 || paying) return;
    setPaying(true);
    setError(null);
    try {
      const body: { idempotencyKey: string; method: string; tenderedAmount?: number; lines: { orderItemId: string; quantity: number }[] } = {
        idempotencyKey: idempotencyKeyRef.current,
        method,
        lines: selectedLines.map((i) => ({ orderItemId: i.orderItemId, quantity: selected[i.orderItemId] })),
      };
      if (method === "CASH" && tendered) body.tenderedAmount = Number(tendered);

      const result = await apiFetch(`/api/pos/orders/${preview.orderId}/split-bill/pay`, { method: "POST", body: JSON.stringify(body) });
      setLastPaidAmount(result.payment.amount);
      idempotencyKeyRef.current = crypto.randomUUID();
      setMethod(null);
      setTendered("");

      if (result.isFinalPayment) {
        router.push("/waiter/tables");
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri naplati");
    } finally {
      setPaying(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;
  if (!preview) return <div className="p-6 text-danger">{error ?? "Porudžbina nije pronađena"}</div>;

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <button onClick={() => router.push(`/waiter/tables/${tableId}`)} className="shrink-0 whitespace-nowrap text-sm font-medium text-gold-dark">
          ← Porudžbina
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold text-ink">{preview.tableLabel} — Podeli račun</h1>
        <div className="flex shrink-0 items-center gap-1">
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>

      {error && <div className="mb-3 whitespace-pre-line rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      {lastPaidAmount && (
        <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm font-medium text-success">
          Naplaćeno {Number(lastPaidAmount).toFixed(2)} RSD — preostale stavke ostaju otvorene ispod.
        </div>
      )}

      {preview.payments.length > 0 && (
        <div className="mb-4 rounded-md border border-line bg-white p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Dosadašnje uplate</div>
          <div className="space-y-1">
            {preview.payments.map((p, idx) => (
              <div key={p.id} className="flex justify-between text-sm text-ink/70">
                <span>{idx + 1}. {PAYMENT_LABEL[p.method]}</span>
                <span>{Number(p.amount).toFixed(2)} RSD</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview.hasUnsentDraftItems && (
        <div className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-sm font-medium text-warn">
          Sto ima neposlate stavke — pošalji ih kuhinji/šanku pre nego što porudžbina može biti u potpunosti zatvorena.
        </div>
      )}

      {preview.items.length === 0 ? (
        <div className="rounded-md border border-line bg-white p-4 text-center text-ink/70">
          {preview.hasUnsentDraftItems
            ? "Sve poslate stavke su naplaćene. Sto ostaje otvoren dok se novi krug ne pošalje i naplati."
            : "Sve stavke su naplaćene. Porudžbina je zatvorena."}
        </div>
      ) : (
        <>
          <div className="mb-2 text-sm font-medium text-inkSoft">Izaberi šta ovaj gost plaća</div>
          <div className="space-y-2 rounded-md border border-line bg-white p-3">
            {preview.items.map((item) => {
              const qty = selected[item.orderItemId] ?? 0;
              return (
                <div key={item.orderItemId} className="flex items-center gap-3 border-b border-line/50 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink" title={item.name}>{item.name}</div>
                    {item.modifiers.length > 0 && (
                      <div className="truncate text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                    )}
                    <div className="text-xs text-inkSoft">{Number(item.unitPrice).toFixed(2)} RSD</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setQuantity(item.orderItemId, item.remaining, qty - 1)}
                      disabled={qty <= 0}
                      aria-label={`Umanji količinu za naplatu — ${item.name}`}
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-12 text-center text-sm font-semibold tabular-nums text-ink">
                      {qty} <span className="font-normal text-inkSoft">/ {item.remaining}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuantity(item.orderItemId, item.remaining, qty + 1)}
                      disabled={qty >= item.remaining}
                      aria-label={`Povećaj količinu za naplatu — ${item.name}`}
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-md bg-gold-soft px-4 py-3.5">
            <span className="text-sm font-semibold text-gold-dark">Izabrano za naplatu</span>
            <span className="text-xl font-bold tabular-nums tracking-tight text-gold-dark">
              {selectedSubtotal.toFixed(2)} <span className="text-xs font-semibold">RSD + PDV</span>
            </span>
          </div>

          <div className="mt-5">
            <div className="mb-2 text-sm font-medium text-inkSoft">Način plaćanja</div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMethod("CASH")}
                className={`rounded-md border-2 py-4 text-base font-semibold transition-colors ${
                  method === "CASH" ? "border-gold bg-gold-soft text-gold-dark" : "border-line bg-white text-ink"
                }`}
              >
                Gotovina
              </button>
              <button
                onClick={() => setMethod("CARD")}
                className={`rounded-md border-2 py-4 text-base font-semibold transition-colors ${
                  method === "CARD" ? "border-gold bg-gold-soft text-gold-dark" : "border-line bg-white text-ink"
                }`}
              >
                Kartica
              </button>
            </div>
          </div>

          {method === "CASH" && (
            <div className="mt-4">
              <label className="mb-1.5 block text-sm font-medium text-inkSoft">Primljena gotovina (opciono)</label>
              <input
                inputMode="decimal"
                className="w-full rounded-md border border-line px-4 py-3 text-lg"
                placeholder={`${selectedSubtotal.toFixed(2)} RSD ili više`}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
              />
              {change !== null && (
                <div className="mt-2 text-sm text-ink/70">Kusur (procena): <span className="font-semibold text-ink">{change.toFixed(2)} RSD</span></div>
              )}
            </div>
          )}

          <button
            onClick={confirmPayment}
            disabled={!method || selectedLines.length === 0 || paying}
            className="mt-6 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 disabled:opacity-40 transition-colors hover:bg-graphite-700"
          >
            {paying ? "Naplata…" : `Naplati izabrano — ${selectedSubtotal.toFixed(2)} RSD`}
          </button>
        </>
      )}
    </div>
  );
}
