"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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

interface Me {
  employeeId: string;
  locationIds: string[];
  roles: string[];
}
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
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

export function ReservationsClient() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(todayDateString());
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [floors, setFloors] = useState<FloorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ReservationRow[] | null>(null);

  const [editing, setEditing] = useState<ReservationRow | "new" | null>(null);
  const [seating, setSeating] = useState<ReservationRow | null>(null);
  const [cancelling, setCancelling] = useState<ReservationRow | null>(null);

  useEffect(() => {
    apiFetch("/api/pos/me")
      .then((m) => {
        setMe(m);
        if (m.locationIds?.[0]) setLocationId(m.locationIds[0]);
      })
      .catch((e) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    try {
      const [resJson, tablesJson] = await Promise.all([
        apiFetch(`/api/pos/reservations?locationId=${locationId}&date=${date}`),
        apiFetch(`/api/pos/tables?locationId=${locationId}`),
      ]);
      setReservations(resJson.reservations);
      setFloors(tablesJson.floors);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [locationId, date]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (search.trim().length < 2) { setSearchResults(null); return; }
    const timer = setTimeout(() => {
      apiFetch(`/api/pos/reservations/search?locationId=${locationId}&q=${encodeURIComponent(search)}`)
        .then((j) => setSearchResults(j.reservations))
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, locationId]);

  const visibleList = searchResults ?? reservations;

  async function doSeat(reservationId: string, tableId: string | null) {
    try {
      await apiFetch(`/api/pos/reservations/${reservationId}/seat`, { method: "POST", body: JSON.stringify({ tableId }) });
      setNotice("Gosti su smešteni.");
      setSeating(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function doNoShow(reservationId: string) {
    try {
      await apiFetch(`/api/pos/reservations/${reservationId}/no-show`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function doComplete(reservationId: string) {
    try {
      await apiFetch(`/api/pos/reservations/${reservationId}/complete`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function doCancel(reservationId: string) {
    try {
      await apiFetch(`/api/pos/reservations/${reservationId}/cancel`, { method: "POST", body: JSON.stringify({}) });
      setCancelling(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className="min-h-screen bg-cream-200 p-3 sm:p-5 lg:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => router.push("/waiter/tables")} className="flex h-11 w-11 items-center justify-center rounded-md text-ink/60 hover:bg-ink/[0.05]" aria-label="Nazad">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.18em] text-gold">Servis sale</p>
              <h1 className="text-xl font-bold tracking-tight text-ink">Rezervacije</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <QuickLockButton />
            <LogoutButton />
          </div>
        </div>

        {notice && <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success">{notice}</div>}
        {error && <div className="mb-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}

        {/* Pretraga */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pretraga po imenu ili telefonu…"
          className="mb-3 min-h-11 w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
        />

        {!searchResults && (
          <div className="mb-4 flex items-center justify-between gap-2 rounded-md border border-line bg-white p-2">
            <button onClick={() => setDate((d) => addDaysToDateString(d, -1))} className="min-h-11 rounded-md px-3 text-sm font-medium text-ink/70 hover:bg-ink/[0.04]">← Juče</button>
            <div className="flex flex-col items-center">
              <button onClick={() => setDate(todayDateString())} className="text-sm font-bold text-ink">
                {date === todayDateString() ? "DANAS" : formatDateLabel(date)}
              </button>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-28 rounded border border-line px-1 py-0.5 text-[11px] text-ink/60" aria-label="Izaberi datum" />
            </div>
            <button onClick={() => setDate((d) => addDaysToDateString(d, 1))} className="min-h-11 rounded-md px-3 text-sm font-medium text-ink/70 hover:bg-ink/[0.04]">Sutra →</button>
          </div>
        )}

        <button
          onClick={() => setEditing("new")}
          className="mb-4 w-full rounded-md bg-gold px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-gold-dark sm:w-auto"
        >
          + Nova rezervacija
        </button>

        {loading ? (
          <p className="text-sm text-inkSoft">Učitavanje…</p>
        ) : visibleList.length === 0 ? (
          <p className="rounded-md border border-line bg-cream-100 p-4 text-sm text-inkSoft">
            {searchResults ? "Nema rezultata." : "Nema rezervacija za ovaj dan."}
          </p>
        ) : (
          <div className="space-y-2">
            {visibleList.map((r) => (
              <div key={r.id} className="rounded-md border border-line/70 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-ink">{timeLabel(r.reservedAt)}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-ink">{r.guestName}</p>
                    <p className="text-xs text-inkSoft">{r.phone} · {r.partySize} osoba</p>
                    <p className="mt-0.5 text-xs text-ink/60">{r.table ? `Sto ${r.table.label} (${r.table.floor.name})` : "Sto nije dodeljen"}</p>
                    {r.note && <p className="mt-1 text-xs italic text-ink/50">{r.note}</p>}
                    {searchResults && <p className="mt-0.5 text-[11px] text-ink/40">{formatDateLabel(r.reservedAt.slice(0, 10))}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {r.status === "CONFIRMED" && (
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
                    {r.status === "SEATED" && (
                      <button onClick={() => doComplete(r.id)} className="min-h-9 rounded-md border border-success/30 bg-success-soft px-2.5 py-1.5 text-xs font-semibold text-success hover:border-success/50">
                        Završeno
                      </button>
                    )}
                  </div>
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
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
      {seating && (
        <SeatModal reservation={seating} floors={floors} onClose={() => setSeating(null)} onConfirm={(tableId) => doSeat(seating.id, tableId)} />
      )}
      {cancelling && (
        <CancelConfirmModal reservation={cancelling} onClose={() => setCancelling(null)} onConfirm={() => doCancel(cancelling.id)} />
      )}
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
  onClose,
  onSaved,
}: {
  reservation: ReservationRow | null;
  locationId: string;
  defaultDate: string;
  floors: FloorOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = reservation === null;
  const [guestName, setGuestName] = useState(reservation?.guestName ?? "");
  const [phone, setPhone] = useState(reservation?.phone ?? "");
  const [date, setDate] = useState(reservation ? reservation.reservedAt.slice(0, 10) : defaultDate);
  const [time, setTime] = useState(reservation ? timeLabel(reservation.reservedAt) : "19:00");
  const [partySize, setPartySize] = useState(String(reservation?.partySize ?? 2));
  const [tableId, setTableId] = useState(reservation?.table?.id ?? "");
  const [note, setNote] = useState(reservation?.note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setError("");
    const payload = {
      guestName,
      phone,
      date,
      time,
      partySize: Number(partySize),
      tableId: tableId || null,
      note: note || undefined,
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
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-elevated sm:max-w-md sm:rounded-lg" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">{isNew ? "Nova rezervacija" : "Izmena rezervacije"}</h2>
            <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink/50 hover:text-ink" aria-label="Zatvori">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <label className="mb-1 block text-sm font-medium text-ink">Ime gosta</label>
          <input value={guestName} onChange={(e) => setGuestName(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Telefon</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <div className="mb-3 flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-ink">Datum</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />
            </div>
            <div className="w-28">
              <label className="mb-1 block text-sm font-medium text-ink">Vreme</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />
            </div>
          </div>

          <label className="mb-1 block text-sm font-medium text-ink">Broj osoba</label>
          <input type="number" inputMode="numeric" min={1} value={partySize} onChange={(e) => setPartySize(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Sto</label>
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm">
            <option value="">Sto nije dodeljen</option>
            {floorOptions(floors)}
          </select>

          <label className="mb-1 block text-sm font-medium text-ink">Napomena (opciono)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm" />

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

function SeatModal({ reservation, floors, onClose, onConfirm }: { reservation: ReservationRow; floors: FloorOption[]; onClose: () => void; onConfirm: (tableId: string | null) => void }) {
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
            disabled={needsTable && !tableId}
            className="min-h-11 flex-1 rounded-md bg-gold px-4 py-2.5 text-sm font-bold text-white hover:bg-gold-dark disabled:opacity-40"
          >
            Smesti goste
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelConfirmModal({ reservation, onClose, onConfirm }: { reservation: ReservationRow; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose} role="alertdialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-ink">Otkaži rezervaciju?</h2>
        <p className="mt-2 text-sm text-inkSoft">
          {reservation.guestName} · {timeLabel(reservation.reservedAt)}. Rezervacija će ostati sačuvana u istoriji kao otkazana.
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={onClose} className="min-h-11 flex-1 rounded-md border border-line px-4 py-2.5 text-sm font-medium text-ink hover:bg-ink/[0.04]">Nazad</button>
          <button onClick={onConfirm} className="min-h-11 flex-1 rounded-md bg-danger px-4 py-2.5 text-sm font-bold text-white hover:bg-danger/90">Otkaži rezervaciju</button>
        </div>
      </div>
    </div>
  );
}
