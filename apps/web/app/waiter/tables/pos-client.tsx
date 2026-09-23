"use client";

import { waiterNavigationStart, waiterNavigationVisible } from "../../../lib/waiter-performance";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";
import { AppLogo } from "../../../components/branding/AppLogo";
import { isTableHeldByAnotherWaiter } from "../../../lib/table-ownership";
import { useWaiterShell } from "../../../lib/waiter-shell";

import type { Table } from "../../../lib/waiter-tables";

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Premium POS tile: JEDAN vizuelni obrazac (bela/tamna površina + tanka
 * leva akcentna traka) za sve statuse umesto po-statusu izmišljenih boja —
 * "restrained status indicators", ne semafor. Vlasništvo (moj sto / sto
 * kolege) je NAMERNO drugi ton iz VEĆ POSTOJEĆE graphite skale
 * (graphite vs graphite-700), ne nova boja — konobar vidi na prvi pogled
 * da je sto zauzet (tamna površina) I da li je njegov, bez dodatnog tapa.
 */
function tileStyle(table: Table, isMine: boolean, hasReady: boolean): string {
  // FAZA 10: SPREMNO obaveštenje nadjačava normalan "zauzet" izgled — mora
  // biti upadljivije od običnog OCCUPIED stanja, ali i dalje profesionalno
  // (gold akcent, već korišćen u ostatku premium UI-ja, ne semafor-crveno).
  // Prikazuje se ISKLJUČIVO odgovornom konobaru (isMine) — "ne obaveštavaj
  // nepovezane konobare".
  if (isMine && hasReady) {
    return "bg-graphite border-gold text-white shadow-card ring-2 ring-gold/70";
  }
  switch (table.status) {
    case "FREE":
      return "bg-white border-line border-l-4 border-l-success/40 text-ink hover:border-l-success active:bg-success-soft/10";
    case "OCCUPIED":
      return isMine
        ? "bg-graphite border-graphite text-white shadow-card"
        : "bg-graphite-700 border-graphite-700 text-white/90 shadow-card";
    case "AWAITING_BILL":
      return "bg-white border-line border-l-4 border-l-warn text-ink";
    case "NEEDS_CLEANING":
    default:
      return "bg-cream-200 border-line text-ink/45";
  }
}

// P0.6 finding #4 — the table CARD (not just the post-tap blocked-table
// modal, already fixed) should say WHO before the waiter even taps. First
// name only, on purpose: the card grid goes down to 2 columns on mobile
// (see the grid className below), and a first name reads safely at that
// width where a full "Ime Prezime" risks fighting the card for space even
// with truncation. The modal after a tap keeps using the fuller
// activeOrderOwnerName directly — this is a card-only concession.
function ownerFirstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function statusLabel(table: Table, isMine: boolean): string {
  switch (table.status) {
    case "FREE":
      return "Slobodan";
    case "OCCUPIED":
      if (isMine) return "Tvoj sto";
      return table.activeOrderOwnerName ? `Zauzeo: ${ownerFirstName(table.activeOrderOwnerName)}` : "Zauzeo kolega";
    case "AWAITING_BILL":
      return "Čeka račun";
    case "NEEDS_CLEANING":
      return "Za čišćenje";
    default:
      return "";
  }
}

const STATUS_DOT: Record<Table["status"], string> = {
  FREE: "bg-success",
  OCCUPIED: "bg-white/70",
  AWAITING_BILL: "bg-warn",
  NEEDS_CLEANING: "bg-ink/25",
};

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function PosClient() {
  const router = useRouter();
  useEffect(() => { waiterNavigationVisible("tables"); }, []);
  // P0.3: identitet/lokacija/smena/stolovi dolaze iz persistent Waiter Shell-a
  // (apps/web/lib/waiter-shell.tsx) — pripremljeni JEDNOM po smeni u layout.tsx
  // koji Next.js nikad ne remontira dok se konobar kreće stolovi<->porudžbina.
  // Ovaj ekran ih SAMO čita, nikad sam ne pokreće pripremu niti ih ponovo
  // preuzima na svaki mount.
  const { data, setShift, readySoundOn, toggleReadySound } = useWaiterShell();
  const { locationId, employeeId, employeeName } = data;
  const shift = data.shift;
  const floors = data.floors;
  const [error, setError] = useState<string | null>(null);
  const [openingCash, setOpeningCash] = useState("");
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Hitna ispravka: sto koji je zauzet od strane DRUGOG konobara — tap
  // otvara ovaj popup umesto navigacije (vidi selectTable ispod).
  const [blockedTable, setBlockedTable] = useState<Table | null>(null);

  // P0.6 finding #1 — selectTable navigates via router.push() from a plain
  // onClick (required so ownership can be checked BEFORE navigating, see
  // below), which does NOT get Next.js's automatic <Link> viewport
  // prefetch. That means the FIRST table tap each session pays for a cold
  // route-chunk fetch on top of the actual order data fetch (traced in
  // order-client.tsx's useLayoutEffect/inspectTable, which already starts
  // its own network read at commit with no render-blocking wait — that
  // part was already correct). Warming the shared [tableId] route once,
  // as soon as real table data is known, removes that one-time cost —
  // pure client-side JS bundle prefetch, no data/business logic involved,
  // and the route module is the same for every table so any one concrete
  // id is enough to warm it for all of them.
  useEffect(() => {
    const firstTable = floors[0]?.tables[0];
    if (firstTable) router.prefetch(`/waiter/tables/${firstTable.id}`);
  }, [floors, router]);
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
    waiterNavigationStart();
    router.push(`/waiter/tables/${table.id}`);
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
          <button
            type="button"
            onClick={toggleReadySound}
            title={readySoundOn ? "Zvuk za SPREMNO — uključen" : "Zvuk za SPREMNO — isključen"}
            aria-label={readySoundOn ? "Isključi zvuk za SPREMNO" : "Uključi zvuk za SPREMNO"}
            aria-pressed={readySoundOn}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-line text-ink/60 hover:bg-ink/[0.04]"
          >
            {readySoundOn ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 6a9 9 0 0 1 0 12" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
            )}
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
              <button
                type="button"
                onClick={toggleReadySound}
                aria-pressed={readySoundOn}
                className="block w-full px-4 py-3 text-left text-sm font-medium text-ink hover:bg-ink/[0.04]"
              >
                {readySoundOn ? "Isključi zvuk za SPREMNO" : "Uključi zvuk za SPREMNO"}
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
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
            {floor.tables.map((table) => {
              const isMine = table.activeOrderOwnerId !== null && table.activeOrderOwnerId === employeeId;
              const hasReady = isMine && table.readyItems.length > 0;
              return (
                <button
                  key={table.id}
                  onClick={() => selectTable(table)}
                  className={`relative flex min-h-[112px] flex-col items-start justify-between overflow-hidden rounded-lg border p-4 text-left transition-all duration-150 active:translate-y-px active:scale-[.98] ${tileStyle(table, isMine, hasReady)}`}
                >
                  {/* Suptilan puls SAMO na dekorativnom prstenu (ne na celoj
                      pločici/tekstu) — broj stola/bedž ostaju uvek čitki,
                      bez "agresivnog treperenja" (specifikacija #2). */}
                  {hasReady && (
                    <span className="pointer-events-none absolute inset-0 animate-pulse rounded-lg ring-2 ring-gold" aria-hidden="true" />
                  )}
                  <span className={`absolute right-3 top-3 h-2 w-2 rounded-full ${STATUS_DOT[table.status]}`} aria-hidden="true" />
                  <span className="text-2xl font-bold tracking-tight">{table.label}</span>
                  <span>
                    {/* truncate (overflow-hidden + ellipsis + nowrap) is a
                        safety net, not the primary defense — ownerFirstName
                        above already keeps this short in the normal case. */}
                    <span className="block truncate text-xs font-semibold opacity-80">{statusLabel(table, isMine)}</span>
                    {hasReady ? (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-gold px-2 py-0.5 text-[11px] font-bold text-white">
                        {table.readyItems.length} spremno
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-[11px] opacity-50">{table.capacity} mesta</span>
                    )}
                  </span>
                </button>
              );
            })}
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
            {/* P0.6 finding #3 — name the actual colleague so the waiter can
                go find them, instead of a generic "drugi konobar". Falls
                back to the old generic wording when the name genuinely
                isn't available (employee record gone) — never a raw ID. */}
            <p className="mb-5 text-sm text-inkSoft">
              {blockedTable.activeOrderOwnerName ? `Sto koristi: ${blockedTable.activeOrderOwnerName}` : "Ovaj sto trenutno vodi drugi konobar."}
            </p>
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
