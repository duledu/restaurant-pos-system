"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";
import { AppLogo } from "../../../components/branding/AppLogo";
import { isTableHeldByAnotherWaiter } from "../../../lib/table-ownership";
import { myReadyItemIds, hasNewReadyId } from "../../../lib/ready-notifications";

interface ReadyItem {
  id: string;
  name: string;
}
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
  // FAZA 10: stavke SPREMNE za preuzimanje na aktivnoj porudžbini ovog
  // stola (prazan niz kad nema nijedne) — vidi table-service.ts listTables.
  readyItems: ReadyItem[];
}

const READY_SOUND_PREF_KEY = "tablecore.waiterReadySound";

function readySoundEnabled(): boolean {
  try {
    return localStorage.getItem(READY_SOUND_PREF_KEY) !== "off"; // podrazumevano UKLJUČEN
  } catch {
    return true;
  }
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

function statusLabel(table: Table, isMine: boolean): string {
  switch (table.status) {
    case "FREE":
      return "Slobodan";
    case "OCCUPIED":
      return isMine ? "Tvoj sto" : "Zauzeo kolega";
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
  const [readySoundOn, setReadySoundOn] = useState(true);

  // FAZA 10 — SPREMNO zvuk: `null` = bazna linija još nije uspostavljena
  // (prvi poziv posle mount-a NIKAD ne zvoni — postojeće SPREMNO stavke iz
  // ranije nisu "nov" događaj za OVU sesiju ekrana). Posle toga, zvoni SAMO
  // kad se pojavi id koji ranije nije bio u skupu — nikad ponovo za isti,
  // već poznat id (bez obzira koliko puta poll ponovi isti odgovor).
  const knownReadyIdsRef = useRef<Set<string> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const employeeIdRef = useRef<string | null>(null);

  useEffect(() => {
    setReadySoundOn(readySoundEnabled());
  }, []);

  useEffect(() => {
    employeeIdRef.current = employeeId;
  }, [employeeId]);

  function beepReady() {
    if (!readySoundEnabled()) return;
    try {
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch {
      // Audio blokiran/nepodržan u ovom browseru (autoplay politika i sl.)
      // — vizuelno obaveštenje (bedž/pulsiranje) i dalje radi bez zvuka.
    }
  }

  function toggleReadySound() {
    const next = !readySoundOn;
    setReadySoundOn(next);
    try {
      localStorage.setItem(READY_SOUND_PREF_KEY, next ? "on" : "off");
    } catch {
      // localStorage nedostupan (privatni režim i sl.) — podešavanje važi
      // samo za trenutnu sesiju, bez greške konobaru.
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await apiFetch("/api/pos/me");
      const loc = me.locationIds[0];
      if (!loc) throw new Error("Nalog nema dodeljenu lokaciju");
      setLocationId(loc);
      setEmployeeId(me.employeeId ?? null);
      employeeIdRef.current = me.employeeId ?? null;
      setEmployeeName(me.firstName ? `${me.firstName} ${me.lastName ?? ""}`.trim() : null);

      const [shiftRes, tablesRes] = await Promise.all([
        apiFetch(`/api/pos/shift?locationId=${loc}`),
        apiFetch(`/api/pos/tables?locationId=${loc}`),
      ]);
      setShift(shiftRes.shift);
      setFloors(tablesRes.floors);
      // Bazna linija — vidi napomenu uz knownReadyIdsRef iznad.
      const allTables = tablesRes.floors.flatMap((f: FloorWithTables) => f.tables);
      knownReadyIdsRef.current = myReadyItemIds(allTables, me.employeeId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, []);

  // PERF: lagan periodični poll SAMO za stolove (ne me/smena, koji se retko
  // menjaju) — isti red veličine kao ostali "uživo" prikazi (KDS 4s, waiter
  // stock 15s). Tiho (bez loading spinnera) i nezavisno od `loading`
  // state-a da ne treperi ekran; greška na jednom ciklusu se tiho preskače
  // (server ionako ostaje autoritativan pri sledećem tapu na sto).
  const refreshTables = useCallback(async () => {
    if (!locationId) return;
    try {
      const tablesRes = await apiFetch(`/api/pos/tables?locationId=${locationId}`);
      const nextFloors: FloorWithTables[] = tablesRes.floors;
      const nextReadyIds = myReadyItemIds(nextFloors.flatMap((f) => f.tables), employeeIdRef.current);
      if (knownReadyIdsRef.current !== null && hasNewReadyId(knownReadyIdsRef.current, nextReadyIds)) {
        beepReady();
      }
      knownReadyIdsRef.current = nextReadyIds;
      setFloors(nextFloors);
    } catch {
      // Tiho pozadinsko osvežavanje — vidi napomenu iznad.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    if (!locationId) return;
    const interval = setInterval(refreshTables, 5000);
    return () => clearInterval(interval);
  }, [locationId, refreshTables]);

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
                    <span className="block text-xs font-semibold opacity-80">{statusLabel(table, isMine)}</span>
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
