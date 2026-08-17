"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { AppLogo } from "../../../components/branding/AppLogo";

interface OpenOrderRef {
  id: string;
  tableLabel: string;
  status: string;
}
interface ShiftSummary {
  shift: { id: string; openedAt: string; status: "OPEN" | "CLOSED" };
  openingCash: string;
  cashTotal: string;
  cardTotal: string;
  expectedCash: string;
  totalRevenue: string;
  orderCount: number;
  openOrders: OpenOrderRef[];
  canClose: boolean;
}
interface ClosedShift {
  id: string;
  countedCash: string;
  expectedCash: string;
  cashDifference: string;
  cardTotal: string;
  totalRevenue: string;
  orderCount: number;
  closedAt: string;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function ShiftClient() {
  const router = useRouter();
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noShift, setNoShift] = useState(false);

  const [countedCash, setCountedCash] = useState("");
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<ClosedShift | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await apiFetch("/api/pos/me");
      const locationId = me.locationIds[0];
      if (!locationId) throw new Error("Nalog nema dodeljenu lokaciju");

      const shiftRes = await apiFetch(`/api/pos/shift?locationId=${locationId}`);
      if (!shiftRes.shift) {
        setNoShift(true);
        return;
      }
      const summaryRes: ShiftSummary = await apiFetch(`/api/pos/shift/${shiftRes.shift.id}`);
      setSummary(summaryRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const expected = useMemo(() => (summary ? Number(summary.expectedCash) : 0), [summary]);
  const difference = useMemo(() => {
    if (!countedCash) return null;
    const counted = Number(countedCash);
    if (Number.isNaN(counted)) return null;
    return counted - expected;
  }, [countedCash, expected]);

  async function closeShift() {
    if (!summary || !countedCash || closing) return;
    setClosing(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/pos/shift/${summary.shift.id}/close`, {
        method: "POST",
        body: JSON.stringify({ countedCash: Number(countedCash) }),
      });
      setClosed(res.shift);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri zatvaranju smene");
    } finally {
      setClosing(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;

  if (noShift) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
        <AppLogo variant="full" size="md" />
        <h1 className="text-xl font-semibold text-ink">Nema aktivne smene</h1>
        <button
          onClick={() => router.push("/waiter/tables")}
          className="rounded-md bg-graphite px-4 py-3 text-base font-medium text-white"
        >
          Nazad na stolove
        </button>
      </div>
    );
  }

  if (closed) {
    const diff = Number(closed.cashDifference);
    return (
      <div className="flex min-h-screen flex-col items-center p-4">
        <div className="w-full max-w-sm">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-ink">Smena zatvorena</h1>
            <LogoutButton />
          </div>
          <div className="rounded-md border border-line bg-white p-4 shadow-sm">
            <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-center text-sm font-medium text-success">
              Zatvoreno u {new Date(closed.closedAt).toLocaleTimeString("sr-RS")}
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-ink/70"><span>Broj računa</span><span>{closed.orderCount}</span></div>
              <div className="flex justify-between text-ink/70"><span>Kartica</span><span>{Number(closed.cardTotal).toFixed(2)} RSD</span></div>
              <div className="flex justify-between text-ink/70"><span>Očekivana gotovina</span><span>{Number(closed.expectedCash).toFixed(2)} RSD</span></div>
              <div className="flex justify-between text-ink/70"><span>Prebrojana gotovina</span><span>{Number(closed.countedCash).toFixed(2)} RSD</span></div>
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink">
                <span>Razlika</span>
                <span className={diff === 0 ? "text-success" : "text-danger"}>
                  {diff > 0 ? "+" : ""}{diff.toFixed(2)} RSD
                </span>
              </div>
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink">
                <span>Ukupan promet</span><span>{Number(closed.totalRevenue).toFixed(2)} RSD</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => router.push("/waiter/tables")}
            className="mt-6 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 transition-colors hover:bg-graphite-700"
          >
            Nazad na stolove
          </button>
        </div>
      </div>
    );
  }

  if (!summary) return <div className="p-6 text-danger">{error ?? "Greška"}</div>;

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => router.push("/waiter/tables")} className="text-sm font-medium text-gold-dark">
          ← Stolovi
        </button>
        <h1 className="text-lg font-semibold text-ink">Zatvaranje smene</h1>
        <LogoutButton />
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {summary.openOrders.length > 0 && (
        <div className="mb-3 rounded-md bg-warn-soft px-3 py-3 text-sm text-warn">
          Ne može se zatvoriti smena — otvoreni računi na stolovima: {summary.openOrders.map((o) => o.tableLabel).join(", ")}.
          Naplati ili zatvori te račune prvo.
        </div>
      )}

      <div className="rounded-md border border-line bg-white p-4 shadow-sm">
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between text-ink/70"><span>Početna gotovina</span><span>{Number(summary.openingCash).toFixed(2)} RSD</span></div>
          <div className="flex justify-between text-ink/70"><span>Broj naplaćenih računa</span><span>{summary.orderCount}</span></div>
          <div className="flex justify-between text-ink/70"><span>Gotovinska prodaja</span><span>{Number(summary.cashTotal).toFixed(2)} RSD</span></div>
          <div className="flex justify-between text-ink/70"><span>Kartična prodaja</span><span>{Number(summary.cardTotal).toFixed(2)} RSD</span></div>
          <div className="flex justify-between border-t border-line pt-2 font-semibold text-ink"><span>Ukupan promet</span><span>{Number(summary.totalRevenue).toFixed(2)} RSD</span></div>
          <div className="flex justify-between text-base font-semibold text-ink"><span>Očekivana gotovina u kasi</span><span>{expected.toFixed(2)} RSD</span></div>
        </div>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-sm font-medium text-inkSoft">Prebrojana gotovina</label>
        <input
          inputMode="decimal"
          className="w-full rounded-md border border-line px-4 py-3 text-lg"
          placeholder={`${expected.toFixed(2)} RSD`}
          value={countedCash}
          onChange={(e) => setCountedCash(e.target.value)}
        />
        {difference !== null && (
          <div className="mt-2 text-sm text-ink/70">
            Razlika:{" "}
            <span className={`font-semibold ${difference === 0 ? "text-success" : "text-danger"}`}>
              {difference > 0 ? "+" : ""}{difference.toFixed(2)} RSD
            </span>
          </div>
        )}
      </div>

      <button
        onClick={closeShift}
        disabled={!summary.canClose || !countedCash || closing}
        className="mt-6 w-full rounded-md bg-graphite py-4 text-lg font-semibold text-cream-100 disabled:opacity-40 transition-colors hover:bg-graphite-700"
      >
        {closing ? "Zatvaranje…" : "Zatvori smenu"}
      </button>
    </div>
  );
}
