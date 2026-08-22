"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../../components/ui/QuickLockButton";
import { TicketPrintPanel, type TicketContent } from "../../../../../components/printing/TicketPrintPanel";
import { fetchPrintJobs, reprintReceipt, printAndConfirm, type PrintJob } from "../../../../../lib/print-client";

interface BillItem {
  id: string;
  name: string;
  price: string;
  quantity: number;
  status: string;
  modifiers: { id: string; optionName: string }[];
}
interface BillPreview {
  order: { id: string; status: string; table: { label: string }; items: BillItem[] };
  subtotal: string;
  tax: string;
  total: string;
  isPaid: boolean;
}
interface Receipt {
  sequenceNumber: number;
  tableLabel: string;
  waiterName: string;
  paymentMethod: "CASH" | "CARD";
  subtotal: string;
  taxTotal: string;
  total: string;
  currency: string;
  issuedAt: string;
  items: { name: string; quantity: number; lineTotal: string; modifiers?: { name: string; priceDelta: string }[] }[];
}
interface PayResult {
  payment: { method: "CASH" | "CARD"; amount: string; tenderedAmount: string; changeAmount: string };
  receipt: Receipt;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const PAYMENT_LABEL: Record<"CASH" | "CARD", string> = { CASH: "Gotovina", CARD: "Kartica" };

export function BillClient({ tableId }: { tableId: string }) {
  const router = useRouter();
  const [bill, setBill] = useState<BillPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [method, setMethod] = useState<"CASH" | "CARD" | null>(null);
  const [tendered, setTendered] = useState("");
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const orderRes = await apiFetch("/api/pos/orders", { method: "POST", body: JSON.stringify({ tableId }) });
      const orderId = orderRes.order.id;
      setOrderId(orderId);

      if (orderRes.order.status === "COMPLETED") {
        const receiptRes = await apiFetch(`/api/pos/orders/${orderId}/receipt`);
        setResult({
          payment: {
            method: receiptRes.receipt.paymentMethod,
            amount: receiptRes.receipt.total,
            tenderedAmount: receiptRes.receipt.total,
            changeAmount: "0.00",
          },
          receipt: receiptRes.receipt,
        });
        return;
      }

      const billRes: BillPreview = await apiFetch(`/api/pos/orders/${orderId}/bill`, { method: "POST" });
      setBill(billRes);
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

  useEffect(() => {
    if (!result || !orderId) return;
    fetchPrintJobs(orderId)
      .then((jobs) => {
        const receiptJob = jobs.find((j) => j.type === "RECEIPT" && !j.isReprint);
        if (receiptJob) setPrintJob(receiptJob);
      })
      .catch(() => {});
  }, [result, orderId]);

  async function handlePrint() {
    if (!orderId || !printJob || printBusy) return;
    setPrintBusy(true);
    setPrintError(null);
    try {
      await printAndConfirm(orderId, printJob.id);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : "Greška pri štampi");
    } finally {
      setPrintBusy(false);
    }
  }

  async function handleReprint() {
    if (!orderId || printBusy) return;
    setPrintBusy(true);
    setPrintError(null);
    try {
      const job = await reprintReceipt(orderId);
      setPrintJob(job);
      window.print();
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : "Greška pri ponovnoj štampi");
    } finally {
      setPrintBusy(false);
    }
  }

  const total = useMemo(() => (bill ? Number(bill.total) : 0), [bill]);
  const change = useMemo(() => {
    const t = Number(tendered);
    if (!tendered || Number.isNaN(t) || t < total) return null;
    return t - total;
  }, [tendered, total]);

  async function pay() {
    if (!bill || !method || paying) return;
    setPaying(true);
    setError(null);
    try {
      const body: { method: string; tenderedAmount?: number } = { method };
      if (method === "CASH" && tendered) body.tenderedAmount = Number(tendered);
      const payRes: PayResult = await apiFetch(`/api/pos/orders/${bill.order.id}/pay`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(payRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri naplati");
    } finally {
      setPaying(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;

  if (result) {
    const { receipt, payment } = result;
    return (
      <div className="flex min-h-screen flex-col items-center p-4">
        <div className="w-full max-w-sm">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-ink">Račun #{receipt.sequenceNumber}</h1>
            <div className="flex items-center gap-1">
              <QuickLockButton />
              <LogoutButton />
            </div>
          </div>

          <div className="rounded-md border border-line bg-white p-4 shadow-sm">
            <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-center text-sm font-medium text-success">
              Plaćanje uspešno — {PAYMENT_LABEL[payment.method]}
            </div>
            <div className="mb-3 text-sm text-ink/70">
              <div>{receipt.tableLabel} · {receipt.waiterName}</div>
              <div>{new Date(receipt.issuedAt).toLocaleString("sr-RS")}</div>
            </div>
            <div className="mb-3 space-y-1 border-t border-line pt-3">
              {receipt.items.map((item, idx) => (
                <div key={idx}>
                  <div className="flex justify-between text-sm text-ink">
                    <span>{item.quantity}× {item.name}</span>
                    <span>{Number(item.lineTotal).toFixed(2)} {receipt.currency}</span>
                  </div>
                  {item.modifiers && item.modifiers.length > 0 && (
                    <div className="text-xs text-inkSoft">{item.modifiers.map((m) => m.name).join(", ")}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="space-y-1 border-t border-line pt-3 text-sm">
              <div className="flex justify-between text-ink/70">
                <span>Osnovica</span>
                <span>{Number(receipt.subtotal).toFixed(2)} {receipt.currency}</span>
              </div>
              <div className="flex justify-between text-ink/70">
                <span>PDV</span>
                <span>{Number(receipt.taxTotal).toFixed(2)} {receipt.currency}</span>
              </div>
              <div className="flex justify-between text-base font-semibold text-ink">
                <span>Ukupno</span>
                <span>{Number(receipt.total).toFixed(2)} {receipt.currency}</span>
              </div>
              {payment.method === "CASH" && Number(payment.changeAmount) > 0 && (
                <div className="flex justify-between text-ink/70">
                  <span>Kusur</span>
                  <span>{Number(payment.changeAmount).toFixed(2)} {receipt.currency}</span>
                </div>
              )}
            </div>
          </div>

          {printError && <div className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{printError}</div>}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={!printJob || printBusy}
              className="rounded-md border-2 border-line bg-white py-3 text-sm font-semibold text-ink disabled:opacity-40"
            >
              {printBusy ? "…" : "Štampaj račun"}
            </button>
            <button
              type="button"
              onClick={handleReprint}
              disabled={printBusy}
              className="rounded-md border-2 border-line bg-white py-3 text-sm font-semibold text-ink disabled:opacity-40"
            >
              Ponovo štampaj
            </button>
          </div>

          <button
            onClick={() => router.push("/waiter/tables")}
            className="mt-3 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 transition-colors hover:bg-graphite-700"
          >
            Sto oslobođen — Nazad na stolove
          </button>
        </div>

        {printJob && <TicketPrintPanel content={printJob.content as TicketContent} />}
      </div>
    );
  }

  if (!bill) return <div className="p-6 text-danger">{error ?? "Porudžbina nije pronađena"}</div>;

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => router.push(`/waiter/tables/${tableId}`)} className="text-sm font-medium text-gold-dark">
          ← Porudžbina
        </button>
        <h1 className="text-lg font-semibold text-ink">{bill.order.table.label} — Račun</h1>
        <div className="flex items-center gap-1">
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>

      {error && <div className="mb-3 whitespace-pre-line rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      <div className="rounded-md border border-line bg-white p-4 shadow-sm">
        <div className="mb-3 space-y-1">
          {bill.order.items
            .filter((item) => item.status !== "CANCELLED")
            .map((item) => (
              <div key={item.id}>
                <div className="flex justify-between text-sm text-ink">
                  <span>{item.quantity}× {item.name}</span>
                  <span>{(Number(item.price) * item.quantity).toFixed(2)} RSD</span>
                </div>
                {item.modifiers.length > 0 && (
                  <div className="text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                )}
              </div>
            ))}
        </div>
        <div className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between text-ink/70">
            <span>Osnovica</span>
            <span>{Number(bill.subtotal).toFixed(2)} RSD</span>
          </div>
          <div className="flex justify-between text-ink/70">
            <span>PDV</span>
            <span>{Number(bill.tax).toFixed(2)} RSD</span>
          </div>
          <div className="flex justify-between text-lg font-semibold text-ink">
            <span>Ukupno</span>
            <span>{Number(bill.total).toFixed(2)} RSD</span>
          </div>
        </div>
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
            placeholder={`${Number(bill.total).toFixed(2)} RSD`}
            value={tendered}
            onChange={(e) => setTendered(e.target.value)}
          />
          {change !== null && (
            <div className="mt-2 text-sm text-ink/70">Kusur: <span className="font-semibold text-ink">{change.toFixed(2)} RSD</span></div>
          )}
        </div>
      )}

      <button
        onClick={pay}
        disabled={!method || paying}
        className="mt-6 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 disabled:opacity-40 transition-colors hover:bg-graphite-700"
      >
        {paying ? "Naplata…" : `Potvrdi plaćanje — ${Number(bill.total).toFixed(2)} RSD`}
      </button>
    </div>
  );
}
