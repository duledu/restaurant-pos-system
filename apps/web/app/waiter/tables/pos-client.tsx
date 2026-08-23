"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";
import { AppLogo } from "../../../components/branding/AppLogo";
import { isTableHeldByAnotherWaiter } from "../../../lib/table-ownership";

interface Table {
  id: string;
  label: string;
  capacity: number;
  status: "FREE" | "OCCUPIED" | "AWAITING_BILL" | "NEEDS_CLEANING";
  // Hitna ispravka: employeeId konobara koji trenutno vodi aktivnu
  // porudžbinu na ovom stolu (null ako nema aktivne porudžbine) — vidi
  // table-service.ts listTables. Nikad ime/lični podaci, samo ID za
  // poređenje sa sopstvenim nalogom PRE navigacije.
  activeOrderOwnerId: string | null;
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

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

const STATUS_STYLE: Record<Table["status"], string> = {
  FREE: "bg-white border-line text-ink hover:border-success/50 hover:bg-success-soft/20",
  OCCUPIED: "bg-graphite text-white border-graphite shadow-[0_8px_22px_rgba(10,25,49,.18)]",
  AWAITING_BILL: "bg-white text-ink border-warn shadow-[inset_4px_0_0_#B45309]",
  NEEDS_CLEANING: "bg-slate-100 text-ink/50 border-slate-300",
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
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [floors, setFloors] = useState<FloorWithTables[]>([]);
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingCash, setOpeningCash] = useState("");
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Hitna ispravka: sto koji je zauzet od strane DRUGOG konobara — tap
  // otvara ovaj popup umesto navigacije (vidi selectTable ispod).
  const [blockedTable, setBlockedTable] = useState<Table | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await apiFetch("/api/pos/me");
      const loc = me.locationIds[0];
      if (!loc) throw new Error("Nalog nema dodeljenu lokaciju");
      setLocationId(loc);
      setEmployeeId(me.employeeId ?? null);
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

  /**
   * Hitna ispravka: vlasništvo se proverava PRE navigacije, ne posle.
   * Slobodan sto ili sto koji vodi TRENUTNI konobar -> normalna navigacija
   * (server (getOwnedDraftOrder) i dalje ostaje krajnji autoritet — ovo je
   * samo UX, ne bezbednosna granica). Sto koji vodi DRUGI konobar -> BEZ
   * navigacije, prikazuje se popup; konobar ostaje na ekranu stolova i
   * odmah može da tapne drugi sto.
   */
  function selectTable(table: Table) {
    if (isTableHeldByAnotherWaiter(table.activeOrderOwnerId, employeeId)) {
      setBlockedTable(table);
      return;
    }
    router.push(`/waiter/tables/${table.id}`);
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
    <div className="min-h-screen bg-cream-200 p-3 sm:p-5 lg:p-6">
      {/* ── Desktop / tablet header (unchanged) ─────────────────────────── */}
      <div className="mb-6 hidden items-center justify-between border-b border-line pb-4 sm:flex">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" size="sm" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-gold">Servis sale</p>
            <h1 className="text-2xl font-bold tracking-tight text-ink">Stolovi</h1>
            {employeeName && <p className="text-xs text-inkSoft">Radiš kao: {employeeName}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/waiter/shift")}
            className="min-h-11 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-xs font-semibold text-success transition-colors hover:border-success/40"
          >
            Smena aktivna — zatvori
          </button>
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>

      {/* ── Mobile header ────────────────────────────────────────────────── */}
      <div className="relative mb-4 sm:hidden">
        <div className="flex items-center justify-between">
          <AppLogo variant="mark" size="sm" />
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink/70 hover:bg-ink/[0.05]"
            aria-label="Više opcija"
            aria-expanded={menuOpen}
          >
            <MoreIcon />
          </button>
        </div>
        <p className="mt-3 text-[10px] font-bold uppercase tracking-[.18em] text-gold">Servis sale</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Stolovi</h1>
        {employeeName && <p className="text-sm text-inkSoft">{employeeName}</p>}
        <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-gold-soft px-2.5 py-1 text-xs font-medium text-gold-dark">
          <span className="h-1.5 w-1.5 rounded-full bg-gold-dark" aria-hidden="true" />
          Smena aktivna
        </div>

        {menuOpen && (
          <>
            <button
              type="button"
              aria-label="Zatvori meni"
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-40 bg-transparent"
            />
            <div className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-md border border-line bg-white shadow-elevated">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  router.push("/waiter/shift");
                }}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-ink/[0.04]"
              >
                Zatvori smenu
              </button>
              <div className="border-t border-line px-2 py-1">
                <QuickLockButton />
              </div>
              <div className="border-t border-line px-2 py-1">
                <LogoutButton />
              </div>
            </div>
          </>
        )}
      </div>

      {error && <div className="mb-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
      {floors.map((floor) => (
        <section key={floor.id} className="mb-8">
          <div className="mb-3 flex items-center justify-between border-b border-line/80 pb-2">
            <h2 className="text-xs font-bold uppercase tracking-[.14em] text-inkSoft">{floor.name}</h2>
            <span className="text-xs tabular-nums text-inkSoft">{floor.tables.filter((t) => t.status === "FREE").length}/{floor.tables.length} slobodno</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
            {floor.tables.map((table) => (
              <button
                key={table.id}
                onClick={() => selectTable(table)}
                className={`group relative flex min-h-[112px] flex-col items-start justify-between overflow-hidden rounded-lg border p-4 text-left transition-all duration-150 active:translate-y-px active:scale-[.98] ${STATUS_STYLE[table.status]}`}
              >
                <span className={`absolute right-3 top-3 h-2.5 w-2.5 rounded-full ${table.status === "FREE" ? "bg-success" : table.status === "OCCUPIED" ? "bg-gold" : table.status === "AWAITING_BILL" ? "bg-warn" : "bg-slate-400"}`} aria-hidden="true" />
                <span className="text-2xl font-bold tracking-tight">{table.label}</span>
                <span>
                  <span className="block text-xs font-semibold opacity-85">{STATUS_LABEL[table.status]}</span>
                  <span className="mt-1 block text-[11px] opacity-55">Kapacitet · {table.capacity}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {blockedTable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setBlockedTable(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="blocked-table-title"
            className="w-full max-w-xs rounded-lg bg-white p-5 text-center shadow-elevated"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="blocked-table-title" className="mb-1.5 text-lg font-bold text-ink">Sto je zauzet</h2>
            <p className="mb-5 text-sm text-inkSoft">Ovaj sto trenutno vodi drugi konobar.</p>
            <button
              type="button"
              onClick={() => setBlockedTable(null)}
              className="min-h-11 w-full rounded-md bg-graphite px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-graphite-700"
            >
              U redu
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
