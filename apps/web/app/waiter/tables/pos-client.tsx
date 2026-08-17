"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";
import { AppLogo } from "../../../components/branding/AppLogo";

interface Table {
  id: string;
  label: string;
  capacity: number;
  status: "FREE" | "OCCUPIED" | "AWAITING_BILL" | "NEEDS_CLEANING";
}
interface FloorWithTables {
  id: string;
  name: string;
  tables: Table[];
}
interface Shift {
  id: string;
  status: string;
}

const STATUS_STYLE: Record<Table["status"], string> = {
  FREE: "bg-white border-line text-ink hover:border-gold/60",
  OCCUPIED: "bg-graphite text-white border-gold",
  AWAITING_BILL: "bg-warn text-white border-warn",
  NEEDS_CLEANING: "bg-cream-300/30 text-ink/40 border-line",
};

const STATUS_LABEL: Record<Table["status"], string> = {
  FREE: "Slobodan",
  OCCUPIED: "Zauzet",
  AWAITING_BILL: "Čeka račun",
  NEEDS_CLEANING: "Za čišćenje",
};

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function PosClient() {
  const router = useRouter();
  const [locationId, setLocationId] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [floors, setFloors] = useState<FloorWithTables[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingCash, setOpeningCash] = useState("");
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await apiFetch("/api/pos/me");
      const loc = me.locationIds[0];
      if (!loc) throw new Error("Nalog nema dodeljenu lokaciju");
      setLocationId(loc);
      setEmployeeName(me.firstName ? `${me.firstName} ${me.lastName ?? ""}`.trim() : null);

      const [shiftRes, tablesRes] = await Promise.all([
        apiFetch(`/api/pos/shift?locationId=${loc}`),
        apiFetch(`/api/pos/tables?locationId=${loc}`),
      ]);
      setShift(shiftRes.shift);
      setFloors(tablesRes.floors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openShift() {
    if (!locationId) return;
    setOpening(true);
    setError(null);
    try {
      const res = await apiFetch("/api/pos/shift", {
        method: "POST",
        body: JSON.stringify({ locationId, openingCash: Number(openingCash) || 0 }),
      });
      setShift(res.shift);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri otvaranju smene");
    } finally {
      setOpening(false);
    }
  }

  async function selectTable(tableId: string) {
    router.push(`/waiter/tables/${tableId}`);
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;
  }

  if (!shift) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 p-6">
        <div className="absolute right-3 top-3 flex items-center gap-1">
          <QuickLockButton />
          <LogoutButton />
        </div>
        <AppLogo variant="full" size="md" />
        <h1 className="text-xl font-semibold text-ink">Nema aktivne smene</h1>
        <p className="text-center text-sm text-ink/70">Unesi početno stanje kase da otvoriš smenu i počneš rad.</p>
        {error && <div className="text-sm text-danger">{error}</div>}
        <input
          className="w-48 rounded-md border border-line px-4 py-3 text-center text-lg"
          placeholder="Početna gotovina"
          value={openingCash}
          onChange={(e) => setOpeningCash(e.target.value)}
        />
        <button
          onClick={openShift}
          disabled={opening}
          className="w-48 rounded-md bg-graphite px-4 py-3 text-lg font-semibold text-white disabled:opacity-40"
        >
          {opening ? "Otvaranje…" : "Otvori smenu"}
        </button>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" size="sm" />
          <div>
            <h1 className="text-xl font-semibold text-ink">Stolovi</h1>
            {employeeName && <p className="text-xs text-inkSoft">Radiš kao: {employeeName}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/waiter/shift")}
            className="rounded-full bg-gold-soft px-3 py-1 text-xs font-medium text-gold-dark transition-colors hover:bg-gold/30"
          >
            Smena aktivna — zatvori
          </button>
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>
      {error && <div className="mb-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
      {floors.map((floor) => (
        <div key={floor.id} className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-ink/70">{floor.name}</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {floor.tables.map((table) => (
              <button
                key={table.id}
                onClick={() => selectTable(table.id)}
                className={`flex aspect-square flex-col items-center justify-center rounded-md border-2 text-center shadow-sm active:scale-95 ${STATUS_STYLE[table.status]}`}
              >
                <span className="text-lg font-bold">{table.label}</span>
                <span className="text-xs opacity-80">{STATUS_LABEL[table.status]}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
