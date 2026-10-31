"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";

// ── Rezervacije V1 ───────────────────────────────────────────────────────
//
// Mobile/tablet-first single page: DANAS lista (hronološki) + navigacija
// datuma + pretraga + kreiranje/izmena/otkazivanje/smeštanje gostiju.
// Reuses the existing /api/pos/tables endpoint for the table picker (floor-
// grouped, shows live occupancy) — no separate floor-plan editor. No native
// alert/confirm/prompt anywhere — every destructive action goes through an
// in-page confirm step, same pattern as Shift Handover/Promotions.

interface ReservationRow {
  id: string;
  guestName: string;
  phone: string;
  partySize: number;
  reservedAt: string;
  note: string | null;
  status: "CONFIRMED" | "SEATED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  table: { id: string; label: string; floor: { id: string; name: string } } | null;
}
interface TableOption {
  id: string;
  label: string;
  status: string;
  capacity: number;
}
interface FloorOption {
  id: string;
  name: string;
  tables: TableOption[];
}

const STATUS_LABEL: Record<ReservationRow["status"], string> = {
  CONFIRMED: "Potvrđeno",
  SEATED: "Smešteni",
  COMPLETED: "Završeno",
  CANCELLED: "Otkazano",
  NO_SHOW: "Nisu došli",
};
const STATUS_BADGE: Record<ReservationRow["status"], string> = {
  CONFIRMED: "border-info/30 bg-info-soft text-info",
  SEATED: "border-gold/40 bg-gold-soft text-gold-dark",
  COMPLETED: "border-success/30 bg-success-soft text-success",
  CANCELLED: "border-line bg-cream-200 text-ink/45",
  NO_SHOW: "border-danger/30 bg-danger-soft text-danger",
};

async function apiFetch(url: string, options?: RequestInit) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal?.addEventListener("abort", abort);
  if (options?.signal?.aborted) abort();
  const timeout = setTimeout(abort, 10000);
  try {
    const res = await fetch(url, { ...options, cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json", ...options?.headers } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
    return body;
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", abort);
  }
}

function dateString(iso: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
function addDaysToDateString(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function formatDateLabel(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}
function timeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function ReservationsClient({ mode = "waiter", locations, timeZone, canManage }: {
  mode?: "admin" | "waiter";
  locations: { id: string; name: string }[];
  timeZone: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const today = () => dateString(new Date(), timeZone);
  const [date, setDate] = useState(today);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [floors, setFloors] = useState<FloorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [status, setStatus] = useState<ReservationRow["status"] | "">("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [details, setDetails] = useState<ReservationRow | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= 2;

  const [editing, setEditing] = useState<ReservationRow | "new" | null>(null);
  const [seating, setSeating] = useState<ReservationRow | null>(null);
  const [cancelling, setCancelling] = useState<ReservationRow | null>(null);
  const actionInFlight = useRef(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (force = true) => {
    if (!mounted.current) return;
    if (!locationId) { setLoading(false); return; }
    if (request.current && !force) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const seq = ++generation.current;
    const current = () => seq === generation.current && !controller.signal.aborted;
    const options = { signal: controller.signal };
    const listUrl = searching
      ? `/api/pos/reservations/search?locationId=${locationId}&q=${encodeURIComponent(query)}`
      : `/api/pos/reservations?locationId=${locationId}&date=${date}`;
    // Table availability and details must not hold up reservation synchronization.
    const jobs = [
      apiFetch(listUrl, options).then(json => { if (current()) setReservations(json.reservations); })
        .finally(() => { if (current()) setLoading(false); }),
      apiFetch(`/api/pos/tables?locationId=${locationId}`, options).then(json => { if (current()) setFloors(json.floors); }),
    ];
    if (detailsId) jobs.push(apiFetch(`/api/pos/reservations/${detailsId}`, options).then(json => { if (current()) setDetails(json.reservation); }));
    const results = await Promise.allSettled(jobs);
    if (!current()) return;
    request.current = null;
    const failed = results.find(result => result.status === "rejected");
    setRefreshError(failed ? "Osvežavanje nije uspelo. Prikaz možda nije ažuran; ponovni pokušaj je automatski." : null);
  }, [locationId, date, query, searching, detailsId]);

  useEffect(() => {
    setLoading(true);
    void load();
    const interval = setInterval(() => void load(false), 4000);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

  const visibleList = reservations.filter(reservation => !status || reservation.status === status);
  const loadRef = useRef(load);
  loadRef.current = load;

  async function transition(reservationId: string, action: string, body?: unknown, onSuccess?: () => void) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActing(true);
    setError(null);
    try {
      await apiFetch(`/api/pos/reservations/${reservationId}/${action}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
      onSuccess?.();
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Potvrda nije stigla. Proverite osvežen status pre ponovnog pokušaja." : (e as Error).message);
    } finally {
      // Re-read after uncertain responses too; never replay a mutation automatically.
      await loadRef.current();
      actionInFlight.current = false;
      setActing(false);
    }
  }
  function doSeat(reservationId: string, tableId: string | null) {
    return transition(reservationId, "seat", { tableId }, () => { setNotice("Gosti su smešteni."); setSeating(null); });
  }
  function doNoShow(reservationId: string) {
    return transition(reservationId, "no-show");
  }
  function doComplete(reservationId: string) {
    return transition(reservationId, "complete");
  }
  function doCancel(reservationId: string) {
    return transition(reservationId, "cancel", {}, () => setCancelling(null));
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className={mode === "admin" ? "w-full" : "min-h-screen bg-cream-200 p-3 sm:p-5 lg:p-6"}>
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode === "waiter" && <button onClick={() => router.push("/waiter/tables")} className="flex h-11 w-11 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[0.05]" aria-label="Nazad">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.18em] text-gold">{mode === "admin" ? "Upravljanje restoranom" : "Servis sale"}</p>
              <h1 className="text-xl font-bold tracking-tight text-ink">Rezervacije</h1>
            </div>
          </div>
          {mode === "waiter" && <div className="flex items-center gap-2">
            <QuickLockButton />
            <LogoutButton />
          </div>}
        </div>

        {notice && <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success">{notice}</div>}
        {error && <div className="mb-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
        {refreshError && <div role="alert" className="mb-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{refreshError}</div>}
        {locations.length === 0 && <p role="alert" className="mb-3 text-sm text-danger">Nalog nema dodeljenu lokaciju.</p>}
        {locations.length > 1 && <select aria-label="Lokacija" value={locationId} onChange={event => {
          setLocationId(event.target.value); setReservations([]); setFloors([]); setDetailsId(null); setDetails(null);
          setEditing(null); setSeating(null); setCancelling(null);
        }} className="mb-3 min-h-11 w-full rounded-md border border-line bg-white px-3 py-2 text-sm">
          {locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>}

        {/* Pretraga */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pretraga po imenu ili telefonu…"
          aria-label="Pretraga rezervacija"
          className="mb-3 min-h-11 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
        />

        {!searching && (
          <div className="mb-4 flex items-center justify-between gap-2 rounded-md border border-line bg-white p-2">
            <button onClick={() => setDate((d) => addDaysToDateString(d, -1))} className="min-h-11 rounded-md px-3 text-sm font-medium text-ink/70 hover:bg-ink/[0.04]">← Juče</button>
            <div className="flex flex-col items-center">
              <button onClick={() => setDate(today())} className="text-sm font-bold text-ink">
                {date === today() ? "DANAS" : formatDateLabel(date)}
              </button>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-28 rounded border border-line px-1 py-0.5 text-[11px] text-ink/60" aria-label="Izaberi datum" />
            </div>
            <button onClick={() => setDate((d) => addDaysToDateString(d, 1))} className="min-h-11 rounded-md px-3 text-sm font-medium text-ink/70 hover:bg-ink/[0.04]">Sutra →</button>
          </div>
        )}

        <select aria-label="Status rezervacije" value={status} onChange={event => setStatus(event.target.value as typeof status)} className="mb-3 min-h-11 w-full rounded-md border border-line bg-white px-3 py-2 text-sm">
          <option value="">Svi statusi</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>

        {canManage && <button
          onClick={() => setEditing("new")}
          disabled={!locationId}
          className="mb-4 w-full rounded-md bg-gold px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-gold-dark sm:w-auto"
        >
          + Nova rezervacija
        </button>}

        {loading ? (
          <p className="text-sm text-inkSoft">Učitavanje…</p>
        ) : visibleList.length === 0 ? (
          <p className="rounded-md border border-line bg-cream-100 p-4 text-sm text-inkSoft">
            {searching || status ? "Nema rezultata." : "Nema rezervacija za ovaj dan."}
          </p>
        ) : (
          <div className="space-y-2">
            {visibleList.map((r) => (
              <div key={r.id} className="rounded-md border border-line/70 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-ink">{timeLabel(r.reservedAt, timeZone)}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-ink">{r.guestName}</p>
                    <p className="text-xs text-inkSoft">{r.phone} · {r.partySize} osoba</p>
                    <p className="mt-0.5 text-xs text-ink/60">{r.table ? `Sto ${r.table.label} (${r.table.floor.name})` : "Sto nije dodeljen"}</p>
                    {r.note && <p className="mt-1 text-xs italic text-ink/50">{r.note}</p>}
                    {searching && <p className="mt-0.5 text-[11px] text-ink/40">{formatDateLabel(dateString(r.reservedAt, timeZone))}</p>}
                  </div>
                  <fieldset disabled={acting} className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <button onClick={() => { setDetails(null); setDetailsId(r.id); }} className="min-h-9 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.04]">Detalji</button>
                    {canManage && r.status === "CONFIRMED" && (
                      <>
                        <button onClick={() => setSeating(r)} className="min-h-9 rounded-md border border-gold/40 bg-gold-soft px-2.5 py-1.5 text-xs font-semibold text-gold-dark hover:border-gold/60">
                          Gosti su stigli
                        </button>
                        <button onClick={() => doNoShow(r.id)} className="min-h-9 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink/60 hover:bg-ink/[0.04]">
                          Nisu došli
                        </button>
                        <button onClick={() => setEditing(r)} className="min-h-9 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-ink/[0.04]">
                          Izmeni
                        </button>
                        <button onClick={() => setCancelling(r)} className="min-h-9 rounded-md border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/5">
                          Otkaži
                        </button>
                      </>
                    )}
                    {canManage && r.status === "SEATED" && (
                      <button onClick={() => doComplete(r.id)} className="min-h-9 rounded-md border border-success/30 bg-success-soft px-2.5 py-1.5 text-xs font-semibold text-success hover:border-success/50">
                        Završeno
                      </button>
                    )}
                  </fieldset>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ReservationModal
          reservation={editing === "new" ? null : editing}
          locationId={locationId}
          defaultDate={date}
          floors={floors}
          timeZone={timeZone}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void loadRef.current(); }}
        />
      )}
      {seating && (
        <SeatModal reservation={seating} floors={floors} busy={acting} onClose={() => setSeating(null)} onConfirm={(tableId) => doSeat(seating.id, tableId)} />
      )}
      {cancelling && (
        <CancelConfirmModal reservation={cancelling} timeZone={timeZone} busy={acting} onClose={() => setCancelling(null)} onConfirm={() => doCancel(cancelling.id)} />
      )}
      {detailsId && <div role="dialog" aria-modal="true" aria-label="Detalji rezervacije" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
        <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-elevated">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold text-ink">Detalji rezervacije</h2>
            <button aria-label="Zatvori detalje" onClick={() => { setDetailsId(null); setDetails(null); }} className="min-h-11 px-3">✕</button></div>
          {details ? <div className="mt-3 space-y-2 text-sm text-ink">
            <p className="font-semibold">{details.guestName}</p>
            <p>{details.phone} · {details.partySize} osoba</p>
            <p>{formatDateLabel(dateString(details.reservedAt, timeZone))} · {timeLabel(details.reservedAt, timeZone)}</p>
            <p>{details.table ? `Sto ${details.table.label} (${details.table.floor.name})` : "Sto nije dodeljen"}</p>
            <p>{STATUS_LABEL[details.status]}</p><p>{details.note || "Bez napomene"}</p>
          </div> : <p className="mt-3 text-sm text-inkSoft">Učitavanje…</p>}
          {refreshError && <p role="alert" className="mt-3 text-sm text-danger">{refreshError}</p>}
        </div>
      </div>}
    </div>
  );
}

function floorOptions(floors: FloorOption[]) {
  return floors.map((floor) => (
    <optgroup key={floor.id} label={floor.name}>
      {floor.tables.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label} · {t.capacity} mesta{t.status === "OCCUPIED" ? " · zauzet" : ""}
        </option>
      ))}
    </optgroup>
  ));
}

function ReservationModal({
  reservation,
  locationId,
  defaultDate,
  floors,
  timeZone,
  onClose,
  onSaved,
}: {
  reservation: ReservationRow | null;
  locationId: string;
  defaultDate: string;
  floors: FloorOption[];
  timeZone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = reservation === null;
  const [guestName, setGuestName] = useState(reservation?.guestName ?? "");
  const [phone, setPhone] = useState(reservation?.phone ?? "");
  const [date, setDate] = useState(reservation ? dateString(reservation.reservedAt, timeZone) : defaultDate);
  const [time, setTime] = useState(reservation ? timeLabel(reservation.reservedAt, timeZone) : "19:00");
  const [partySize, setPartySize] = useState(String(reservation?.partySize ?? 2));
  const [tableId, setTableId] = useState(reservation?.table?.id ?? "");
  const [note, setNote] = useState(reservation?.note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setError("");
    const payload = {
      guestName,
      phone,
      date,
      time,
      partySize: Number(partySize),
      tableId: tableId || null,
      note,
      ...(isNew ? { locationId } : {}),
    };
    setSaving(true);
    try {
      if (isNew) {
        await apiFetch("/api/pos/reservations", { method: "POST", body: JSON.stringify(payload) });
      } else {
        await apiFetch(`/api/pos/reservations/${reservation!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={isNew ? "Nova rezervacija" : "Izmena rezervacije"}>
      <div className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-elevated sm:max-w-md sm:rounded-lg" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">{isNew ? "Nova rezervacija" : "Izmena rezervacije"}</h2>
            <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink/50 hover:text-ink" aria-label="Zatvori">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <label className="mb-1 block text-sm font-medium text-ink">Ime gosta</label>
          <input aria-label="Ime gosta" value={guestName} onChange={(e) => setGuestName(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Telefon</label>
          <input aria-label="Telefon" value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <div className="mb-3 flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-ink">Datum</label>
              <input aria-label="Datum rezervacije" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />
            </div>
            <div className="w-28">
              <label className="mb-1 block text-sm font-medium text-ink">Vreme</label>
              <input aria-label="Vreme rezervacije" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />
            </div>
          </div>

          <label className="mb-1 block text-sm font-medium text-ink">Broj osoba</label>
          <input aria-label="Broj osoba" type="number" inputMode="numeric" min={1} value={partySize} onChange={(e) => setPartySize(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Sto</label>
          <select aria-label="Sto" value={tableId} onChange={(e) => setTableId(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm">
            <option value="">Sto nije dodeljen</option>
            {floorOptions(floors)}
          </select>

          <label className="mb-1 block text-sm font-medium text-ink">Napomena (opciono)</label>
          <textarea aria-label="Napomena" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm" />

          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
        </div>
        <div className="border-t border-line px-5 py-4">
          <button
            onClick={save}
            disabled={saving || !guestName.trim() || !phone.trim() || !date || !time || Number(partySize) < 1}
            className="w-full rounded-md bg-gold px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-gold-dark disabled:opacity-40"
          >
            {saving ? "Čuvanje…" : "Sačuvaj rezervaciju"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SeatModal({ reservation, floors, busy, onClose, onConfirm }: { reservation: ReservationRow; floors: FloorOption[]; busy: boolean; onClose: () => void; onConfirm: (tableId: string | null) => void }) {
  const [tableId, setTableId] = useState(reservation.table?.id ?? "");
  const needsTable = !reservation.table;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-ink">Gosti su stigli</h2>
        <p className="mt-1 text-sm text-inkSoft">{reservation.guestName} · {reservation.partySize} osoba</p>
        {reservation.table ? (
          <p className="mt-3 text-sm text-ink">Sto {reservation.table.label} ({reservation.table.floor.name})</p>
        ) : (
          <>
            <label className="mb-1 mt-3 block text-sm font-medium text-ink">Izaberi sto</label>
            <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm">
              <option value="">— izaberi sto —</option>
              {floorOptions(floors)}
            </select>
          </>
        )}
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="min-h-11 flex-1 rounded-md border border-line px-4 py-2.5 text-sm font-medium text-ink hover:bg-ink/[0.04]">Nazad</button>
          <button
            onClick={() => onConfirm(needsTable ? tableId || null : null)}
            disabled={busy || (needsTable && !tableId)}
            className="min-h-11 flex-1 rounded-md bg-gold px-4 py-2.5 text-sm font-bold text-white hover:bg-gold-dark disabled:opacity-40"
          >
            Smesti goste
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelConfirmModal({ reservation, timeZone, busy, onClose, onConfirm }: { reservation: ReservationRow; timeZone: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose} role="alertdialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-ink">Otkaži rezervaciju?</h2>
        <p className="mt-2 text-sm text-inkSoft">
          {reservation.guestName} · {timeLabel(reservation.reservedAt, timeZone)}. Rezervacija će ostati sačuvana u istoriji kao otkazana.
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="min-h-11 flex-1 rounded-md border border-line px-4 py-2.5 text-sm font-medium text-ink hover:bg-ink/[0.04]">Nazad</button>
          <button disabled={busy} onClick={onConfirm} className="min-h-11 flex-1 rounded-md bg-danger px-4 py-2.5 text-sm font-bold text-white hover:bg-danger/90 disabled:opacity-40">Otkaži rezervaciju</button>
        </div>
      </div>
    </div>
  );
}
