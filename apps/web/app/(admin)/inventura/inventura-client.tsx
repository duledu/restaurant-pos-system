"use client";

import { useEffect, useState, useCallback, useMemo } from "react";

interface SessionSummary {
  id: string;
  locationId: string;
  status: "OPEN" | "CONFIRMED";
  startedByName: string;
  startedAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  lineCount: number;
  countedCount: number;
  staleCount: number;
}
interface SessionLine {
  id: string;
  targetType: "INGREDIENT" | "MENU_ITEM";
  name: string;
  unit: string;
  ingredientId: string | null;
  menuItemId: string | null;
  systemQtySnapshot: string;
  physicalQty: string | null;
  status: "NOT_COUNTED" | "MATCH" | "SHORTAGE" | "SURPLUS" | "STALE";
  countedByName: string | null;
  countedAt: string | null;
  correctionMovementId: string | null;
}
interface SessionDetail {
  id: string;
  locationId: string;
  status: "OPEN" | "CONFIRMED";
  startedByName: string;
  startedAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  lines: SessionLine[];
}
interface Location {
  id: string;
  name: string;
}
interface Ingredient {
  id: string;
  name: string;
  unit: string;
}
interface MenuItemOption {
  id: string;
  name: string;
  inventoryTrackingMethod: string;
}

const STATUS_LABEL: Record<SessionLine["status"], string> = {
  NOT_COUNTED: "Nije prebrojano",
  MATCH: "Poklapa se",
  SHORTAGE: "Manjak",
  SURPLUS: "Višak",
  STALE: "Stanje promenjeno",
};
const STATUS_STYLE: Record<SessionLine["status"], string> = {
  NOT_COUNTED: "bg-cream-200 text-inkSoft",
  MATCH: "bg-success-soft text-success",
  SHORTAGE: "bg-danger-soft text-danger",
  SURPLUS: "bg-warn-soft text-warn",
  STALE: "bg-danger text-white",
};

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function InventuraClient() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOwnerAdmin, setIsOwnerAdmin] = useState(false);

  const loadLocations = useCallback(async () => {
    // Nijedan od ova dva ne zavisi od drugog (me.roles vs. lista lokacija) —
    // nema razloga da čekaju jedan na drugog.
    const [me, res] = await Promise.all([apiFetch("/api/pos/me"), apiFetch("/api/admin/locations")]);
    setIsOwnerAdmin((me.roles ?? []).some((r: string) => ["OWNER", "ADMIN"].includes(r)));
    setLocations(res.locations);
    if (res.locations.length > 0) setLocationId((prev) => prev || res.locations[0].id);
  }, []);

  const loadSessions = useCallback(async () => {
    if (!locationId) return;
    const res = await apiFetch(`/api/admin/inventory/count-sessions?locationId=${locationId}`);
    setSessions(res.sessions);
  }, [locationId]);

  useEffect(() => {
    loadLocations().catch((e) => setError(e instanceof Error ? e.message : "Greška")).finally(() => setLoading(false));
  }, [loadLocations]);

  useEffect(() => {
    if (locationId) loadSessions().catch((e) => setError(e instanceof Error ? e.message : "Greška"));
  }, [locationId, loadSessions]);

  async function openSession(id: string) {
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/inventory/count-sessions/${id}`);
      setActiveSession(res.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function startNewSession() {
    if (!locationId) return;
    setError(null);
    try {
      const res = await apiFetch("/api/admin/inventory/count-sessions", {
        method: "POST",
        body: JSON.stringify({ locationId }),
      });
      setActiveSession(res.session);
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function refreshActive() {
    if (!activeSession) return;
    await openSession(activeSession.id);
    await loadSessions();
  }

  if (loading) return <div className="p-6 text-ink/55">Učitavanje…</div>;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Inventura</h1>
        {locations.length > 1 && (
          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setActiveSession(null);
            }}
            className="rounded-md border border-line bg-white px-3 py-2 text-sm"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {activeSession ? (
        <SessionDetailView
          session={activeSession}
          isOwnerAdmin={isOwnerAdmin}
          onBack={() => {
            setActiveSession(null);
            loadSessions();
          }}
          onRefresh={refreshActive}
          setError={setError}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={startNewSession}
            className="mb-5 min-h-11 rounded-md bg-graphite px-5 py-2.5 text-sm font-semibold text-cream-100 hover:bg-graphite-700"
          >
            Nova / nastavi sesiju
          </button>

          <div className="overflow-x-auto rounded-lg border border-line bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Započeo</th>
                  <th className="px-4 py-3 font-medium">Stavke</th>
                  <th className="px-4 py-3 font-medium">Potvrđeno</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-cream-200/60" onClick={() => openSession(s.id)}>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.status === "OPEN" ? "bg-warn-soft text-warn" : "bg-success-soft text-success"}`}>
                        {s.status === "OPEN" ? "U toku" : "Potvrđeno"}
                      </span>
                      {s.staleCount > 0 && <span className="ml-2 rounded-full bg-danger-soft px-2 py-0.5 text-xs font-semibold text-danger">{s.staleCount} promenjeno</span>}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {s.startedByName} · {new Date(s.startedAt).toLocaleString("sr-RS")}
                    </td>
                    <td className="px-4 py-3 text-inkSoft">
                      {s.countedCount}/{s.lineCount} prebrojano
                    </td>
                    <td className="px-4 py-3 text-inkSoft">{s.confirmedAt ? `${s.confirmedByName} · ${new Date(s.confirmedAt).toLocaleString("sr-RS")}` : "—"}</td>
                  </tr>
                ))}
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-ink/55">
                      Nema sesija inventure za ovu lokaciju.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SessionDetailView({
  session,
  isOwnerAdmin,
  onBack,
  onRefresh,
  setError,
}: {
  session: SessionDetail;
  isOwnerAdmin: boolean;
  onBack: () => void;
  onRefresh: () => void;
  setError: (e: string | null) => void;
}) {
  const [tab, setTab] = useState<"INGREDIENT" | "MENU_ITEM">("INGREDIENT");
  const [picker, setPicker] = useState(false);
  const [candidates, setCandidates] = useState<(Ingredient | MenuItemOption)[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [overrideIds, setOverrideIds] = useState<Set<string>>(new Set());

  const readOnly = session.status === "CONFIRMED";
  const ingredientLines = session.lines.filter((l) => l.targetType === "INGREDIENT");
  const menuItemLines = session.lines.filter((l) => l.targetType === "MENU_ITEM");
  const staleLines = useMemo(() => session.lines.filter((l) => l.status === "STALE"), [session.lines]);

  async function openPicker(type: "INGREDIENT" | "MENU_ITEM") {
    setTab(type);
    setPicker(true);
    setSelectedIds(new Set());
    setPickerSearch("");
    try {
      if (type === "INGREDIENT") {
        const res = await apiFetch(`/api/admin/ingredients?locationId=${session.locationId}&activeOnly=true`);
        setCandidates(res.ingredients);
      } else {
        const res = await apiFetch(`/api/admin/menu/items?locationId=${session.locationId}&activeOnly=true`);
        setCandidates((res.items as (MenuItemOption & { inventoryTrackingMethod: string })[]).filter((i) => i.inventoryTrackingMethod === "DIRECT_STOCK"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function addSelected() {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const targets = [...selectedIds].map((id) => (tab === "INGREDIENT" ? { targetType: "INGREDIENT", ingredientId: id } : { targetType: "MENU_ITEM", menuItemId: id }));
      await apiFetch(`/api/admin/inventory/count-sessions/${session.id}/lines`, { method: "POST", body: JSON.stringify({ targets }) });
      setPicker(false);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  }

  async function enterQty(lineId: string, value: string) {
    const num = Number(value);
    if (value === "" || Number.isNaN(num) || num < 0) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/inventory/count-sessions/${session.id}/lines/${lineId}`, { method: "POST", body: JSON.stringify({ physicalQty: num }) });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function recount(lineId: string) {
    setError(null);
    try {
      await apiFetch(`/api/admin/inventory/count-sessions/${session.id}/lines/${lineId}/recount`, { method: "POST" });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/inventory/count-sessions/${session.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ overrideStaleLineIds: [...overrideIds] }),
      });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  }

  const filteredCandidates = candidates.filter((c) => c.name.toLowerCase().includes(pickerSearch.toLowerCase()));

  function renderLines(lines: SessionLine[]) {
    if (lines.length === 0) return <p className="py-4 text-sm text-ink/55">Nema dodatih stavki.</p>;
    return (
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
              <th className="px-3 py-2.5 font-medium">Naziv</th>
              <th className="px-3 py-2.5 text-right font-medium">Sistemsko</th>
              <th className="px-3 py-2.5 text-right font-medium">Fizičko</th>
              <th className="px-3 py-2.5 text-right font-medium">Razlika</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              {!readOnly && <th className="px-3 py-2.5 font-medium">Akcija</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const diff = l.physicalQty !== null ? Number(l.physicalQty) - Number(l.systemQtySnapshot) : null;
              return (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2.5 font-medium text-ink">{l.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-inkSoft">
                    {l.systemQtySnapshot} {l.unit}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {readOnly ? (
                      <span className="tabular-nums text-ink">{l.physicalQty ?? "—"}</span>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        step="0.001"
                        defaultValue={l.physicalQty ?? ""}
                        onBlur={(e) => enterQty(l.id, e.target.value)}
                        disabled={l.status === "STALE"}
                        className="w-24 rounded-md border border-line px-2 py-1.5 text-right text-sm disabled:opacity-50"
                      />
                    )}
                  </td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${diff && diff < 0 ? "text-danger" : diff && diff > 0 ? "text-warn" : "text-ink/55"}`}>
                    {diff !== null ? (diff > 0 ? `+${diff}` : diff) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[l.status]}`}>{STATUS_LABEL[l.status]}</span>
                  </td>
                  {!readOnly && (
                    <td className="px-3 py-2.5">
                      {l.status === "STALE" && (
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => recount(l.id)} className="min-h-9 rounded-md bg-graphite px-2.5 py-1 text-xs font-semibold text-cream-100">
                            Prebroj ponovo
                          </button>
                          {isOwnerAdmin && (
                            <label className="flex items-center gap-1 text-xs text-ink/70">
                              <input
                                type="checkbox"
                                checked={overrideIds.has(l.id)}
                                onChange={(e) => {
                                  const next = new Set(overrideIds);
                                  if (e.target.checked) next.add(l.id);
                                  else next.delete(l.id);
                                  setOverrideIds(next);
                                }}
                              />
                              Odobri
                            </label>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 text-sm font-medium text-gold-dark">
        ← Sve sesije
      </button>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${session.status === "OPEN" ? "bg-warn-soft text-warn" : "bg-success-soft text-success"}`}>
            {session.status === "OPEN" ? "U toku" : "Potvrđeno"}
          </span>
          <span className="ml-2 text-sm text-ink/70">
            {session.startedByName} · {new Date(session.startedAt).toLocaleString("sr-RS")}
          </span>
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="min-h-11 rounded-md bg-success px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40"
          >
            Potvrdi inventuru
          </button>
        )}
      </div>

      {staleLines.length > 0 && (
        <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {staleLines.length} stavk{staleLines.length === 1 ? "a je" : "e su"} promenjene tokom prebrojavanja — ponovo prebroj ili (Vlasnik/Administrator) odobri override pre potvrde.
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setTab("INGREDIENT")}
          className={`min-h-11 rounded-md px-4 py-2 text-sm font-semibold ${tab === "INGREDIENT" ? "bg-graphite text-white" : "border border-line bg-white text-ink/75"}`}
        >
          Sirovine ({ingredientLines.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("MENU_ITEM")}
          className={`min-h-11 rounded-md px-4 py-2 text-sm font-semibold ${tab === "MENU_ITEM" ? "bg-graphite text-white" : "border border-line bg-white text-ink/75"}`}
        >
          Gotovi proizvodi ({menuItemLines.length})
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={() => openPicker(tab)}
            className="ml-auto min-h-11 rounded-md border-2 border-gold/60 bg-white px-4 py-2 text-sm font-semibold text-gold-dark"
          >
            + Dodaj stavke
          </button>
        )}
      </div>

      {renderLines(tab === "INGREDIENT" ? ingredientLines : menuItemLines)}

      {picker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={() => setPicker(false)}>
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-lg font-bold text-ink">Dodaj {tab === "INGREDIENT" ? "sirovine" : "gotove proizvode"}</h2>
            <input
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder="Pretraga…"
              className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm"
            />
            <div className="mb-4 max-h-72 space-y-1 overflow-y-auto">
              {filteredCandidates.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setSelectedIds(next);
                    }}
                  />
                  {c.name}
                </label>
              ))}
              {filteredCandidates.length === 0 && <p className="text-sm text-ink/55">Nema rezultata.</p>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setPicker(false)} className="min-h-11 rounded-md bg-cream-200 text-sm font-semibold text-ink">
                Otkaži
              </button>
              <button
                type="button"
                disabled={selectedIds.size === 0 || busy}
                onClick={addSelected}
                className="min-h-11 rounded-md bg-graphite text-sm font-semibold text-cream-100 disabled:opacity-40"
              >
                Dodaj ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
