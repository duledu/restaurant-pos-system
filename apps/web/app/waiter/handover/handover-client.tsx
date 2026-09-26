"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../components/ui/QuickLockButton";

// ── Shift Handover V1 — Preuzimanje/Predaja stolova ─────────────────────────
//
// Mobile/tablet-first single page covering:
//   - overview ("11 otvorenih, 7/11 preuzeto")
//   - PREUZIMANJE STOLOVA (claim from other waiters, grouped by current owner)
//   - PREDAJA STOLOVA (hand off my own open tables to another waiter)
//   - MANAGER: prinudno preuzimanje (OWNER/ADMIN/MANAGER only)
//
// Reuses the existing table-ownership-transfer engine via /api/pos/handover/*
// — no separate ownership/authorization model. Confirmation is the existing
// authenticated session (no native alert/confirm/prompt anywhere here; every
// action goes through an in-page "pregled -> potvrdi" step, same pattern
// already established by Admin's OpeningStockModal).

const MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

interface Me {
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
  locationIds: string[];
  roles: string[];
}
interface TakeoverTable {
  tableId: string;
  tableLabel: string;
  orderId: string;
  itemCount: number;
  status: string;
}
interface TakeoverGroup {
  employeeId: string;
  employeeName: string;
  tables: TakeoverTable[];
}
interface MyTable {
  tableId: string;
  tableLabel: string;
  orderId: string;
  itemCount: number;
  status: string;
}
interface Waiter {
  employeeId: string;
  employeeName: string;
}
interface Overview {
  totalOpenTables: number;
  transferredCount: number;
  pendingTables: Array<{ tableId: string; tableLabel: string; orderId: string; currentOwnerId: string; currentOwnerName: string; itemCount: number }>;
  transferredTables: Array<{ tableId: string; tableLabel: string; orderId: string; previousOwnerName: string; newOwnerName: string; transferredAt: string }>;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function readInitialTab(): "preuzmi" | "predaj" {
  if (typeof window === "undefined") return "preuzmi";
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "handoff" || tab === "predaj" ? "predaj" : "preuzmi";
}

export function HandoverClient() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [locationId, setLocationId] = useState("");
  const [tab, setTab] = useState<"preuzmi" | "predaj" | "manager">(readInitialTab());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [groups, setGroups] = useState<TakeoverGroup[]>([]);
  const [myTables, setMyTables] = useState<MyTable[]>([]);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isManager = me ? me.roles.some((r) => MANAGEMENT_ROLES.has(r)) : false;

  const load = useCallback(async (loc: string) => {
    setLoading(true);
    setError(null);
    try {
      const [ov, tk, mt, wl] = await Promise.all([
        apiFetch(`/api/pos/handover/overview?locationId=${loc}`),
        apiFetch(`/api/pos/handover/takeover-candidates?locationId=${loc}`),
        apiFetch(`/api/pos/handover/my-tables?locationId=${loc}`),
        apiFetch(`/api/pos/handover/waiters?locationId=${loc}`),
      ]);
      setOverview(ov);
      setGroups(tk.groups ?? []);
      setMyTables(mt.tables ?? []);
      setWaiters(wl.waiters ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    apiFetch("/api/pos/me").then((m: Me) => {
      setMe(m);
      const loc = m.locationIds[0];
      if (loc) {
        setLocationId(loc);
        load(loc);
      } else {
        setLoading(false);
        setError("Nalog nema dodeljenu lokaciju");
      }
    }).catch((e) => { setError(e instanceof Error ? e.message : "Greška"); setLoading(false); });
  }, [load]);

  function refresh() {
    if (locationId) load(locationId);
  }

  return (
    <div className="flex min-h-screen flex-col p-4 pb-8">
      <div className="mb-3 flex items-center justify-between">
        <button onClick={() => router.push("/waiter/tables")} className="text-sm font-medium text-gold-dark">
          ← Stolovi
        </button>
        <h1 className="text-lg font-semibold text-ink">Predaja smene</h1>
        <div className="flex items-center gap-1">
          <QuickLockButton />
          <LogoutButton />
        </div>
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      {notice && <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-sm text-success">{notice}</div>}

      {overview && (
        <div className="mb-3 rounded-md border border-line bg-white p-3 shadow-sm">
          <p className="text-sm font-semibold text-ink">
            {overview.totalOpenTables} otvoren{overview.totalOpenTables === 1 ? "" : "ih"} sto{overview.totalOpenTables === 1 ? "" : "ova"}
          </p>
          <p className="text-xs text-ink/60">
            {overview.transferredCount} / {overview.totalOpenTables} preuzeto
            {overview.totalOpenTables - overview.transferredCount > 0 && ` · ${overview.totalOpenTables - overview.transferredCount} čeka novog konobara`}
          </p>
        </div>
      )}

      <div className="mb-4 flex gap-1.5 rounded-md border border-line bg-white p-1">
        <button
          onClick={() => setTab("preuzmi")}
          className={`flex-1 rounded-sm py-2 text-sm font-medium transition-colors ${tab === "preuzmi" ? "bg-gold-soft text-gold-dark" : "text-ink/60"}`}
        >
          Preuzmi stolove
        </button>
        <button
          onClick={() => setTab("predaj")}
          className={`flex-1 rounded-sm py-2 text-sm font-medium transition-colors ${tab === "predaj" ? "bg-gold-soft text-gold-dark" : "text-ink/60"}`}
        >
          Predaj stolove
        </button>
        {isManager && (
          <button
            onClick={() => setTab("manager")}
            className={`flex-1 rounded-sm py-2 text-sm font-medium transition-colors ${tab === "manager" ? "bg-gold-soft text-gold-dark" : "text-ink/60"}`}
          >
            Menadžer
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-ink/55">Učitavanje…</p>
      ) : tab === "preuzmi" ? (
        <TakeoverPanel groups={groups} myEmployeeId={me?.employeeId ?? ""} onDone={(msg) => { setNotice(msg); refresh(); }} onError={setError} />
      ) : tab === "predaj" ? (
        <HandoffPanel myTables={myTables} waiters={waiters} myEmployeeId={me?.employeeId ?? ""} onDone={(msg) => { setNotice(msg); refresh(); }} onError={setError} />
      ) : (
        <ManagerPanel overview={overview} waiters={waiters} onDone={(msg) => { setNotice(msg); refresh(); }} onError={setError} />
      )}
    </div>
  );
}

// ── PREUZMI ──────────────────────────────────────────────────────────────

function TakeoverPanel({
  groups,
  myEmployeeId,
  onDone,
  onError,
}: {
  groups: TakeoverGroup[];
  myEmployeeId: string;
  onDone: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [busy, setBusy] = useState(false);

  const allTables = useMemo(() => groups.flatMap((g) => g.tables.map((t) => ({ ...t, ownerId: g.employeeId, ownerName: g.employeeName }))), [groups]);
  const selectedTables = allTables.filter((t) => selected.has(t.orderId));

  function toggle(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(orderId) ? next.delete(orderId) : next.add(orderId);
      return next;
    });
  }
  function toggleGroup(group: TakeoverGroup) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = group.tables.every((t) => next.has(t.orderId));
      for (const t of group.tables) allIn ? next.delete(t.orderId) : next.add(t.orderId);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(allTables.map((t) => t.orderId)));
  }

  async function confirmTakeover() {
    setBusy(true);
    onError(null);
    try {
      const result = await apiFetch("/api/pos/handover/transfer", {
        method: "POST",
        body: JSON.stringify({
          reason: "SHIFT_HANDOVER",
          transfers: selectedTables.map((t) => ({ orderId: t.orderId, expectedPreviousOwnerId: t.ownerId, newOwnerId: myEmployeeId })),
        }),
      });
      const n = result.succeeded.length;
      if (result.failed.length > 0) {
        onError(`${result.failed.length} sto${result.failed.length === 1 ? "" : "ova"} nije preuzeto (već preuzeto od strane drugog konobara) — prikaz je osvežen.`);
      }
      onDone(n > 0 ? `Preuzeo/la si ${n} sto${n === 1 ? "" : "ova"}.` : "Nijedan sto nije preuzet.");
      setSelected(new Set());
      setStep("select");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Greška pri preuzimanju");
    } finally {
      setBusy(false);
    }
  }

  if (groups.length === 0) {
    return <p className="rounded-md border border-line bg-white p-4 text-center text-sm text-ink/55">Nema dostupnih stolova za preuzimanje.</p>;
  }

  if (step === "confirm") {
    return (
      <div>
        <div className="mb-3 rounded-md border border-line bg-white p-3">
          <p className="mb-2 text-sm font-semibold text-ink">Preuzimaš {selectedTables.length} sto{selectedTables.length === 1 ? "" : "ova"}:</p>
          <ul className="space-y-1 text-sm text-ink/75">
            {selectedTables.map((t) => (
              <li key={t.orderId} className="flex justify-between border-b border-line/50 py-1 last:border-0">
                <span>{t.tableLabel}</span>
                <span className="text-ink/50">od {t.ownerName}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setStep("select")} className="flex-1 rounded-md border-2 border-line py-3 text-sm font-semibold text-ink">Nazad</button>
          <button
            onClick={confirmTakeover}
            disabled={busy}
            className="flex-1 rounded-md bg-graphite py-3 text-sm font-semibold text-cream-100 disabled:opacity-40"
          >
            {busy ? "Preuzimanje…" : `Preuzmi ${selectedTables.length} stolova`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={selectAll} className="mb-3 w-full rounded-md border-2 border-gold-dark py-2.5 text-sm font-semibold text-gold-dark">
        Preuzmi sve ({allTables.length})
      </button>
      <div className="space-y-3">
        {groups.map((g) => {
          const allIn = g.tables.every((t) => selected.has(t.orderId));
          return (
            <div key={g.employeeId} className="rounded-md border border-line bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">{g.employeeName} — {g.tables.length} otvoren{g.tables.length === 1 ? "" : "ih"}</p>
                <button onClick={() => toggleGroup(g)} className="text-xs font-medium text-gold-dark">
                  {allIn ? "Poništi sve" : "Izaberi sve"}
                </button>
              </div>
              <div className="space-y-1.5">
                {g.tables.map((t) => (
                  <label key={t.orderId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 hover:bg-cream-100">
                    <input type="checkbox" checked={selected.has(t.orderId)} onChange={() => toggle(t.orderId)} className="h-5 w-5 cursor-pointer accent-gold" />
                    <span className="flex-1 text-sm text-ink">{t.tableLabel}</span>
                    <span className="text-xs text-ink/50">{t.itemCount} stavki</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {selected.size > 0 && (
        <button
          onClick={() => setStep("confirm")}
          className="fixed inset-x-4 bottom-4 rounded-md bg-graphite py-4 text-base font-semibold text-cream-100 shadow-elevated sm:static sm:mt-4"
        >
          Preuzmi {selected.size} sto{selected.size === 1 ? "" : "ova"}
        </button>
      )}
    </div>
  );
}

// ── PREDAJ ───────────────────────────────────────────────────────────────

function HandoffPanel({
  myTables,
  waiters,
  myEmployeeId,
  onDone,
  onError,
}: {
  myTables: MyTable[];
  waiters: Waiter[];
  myEmployeeId: string;
  onDone: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetWaiterId, setTargetWaiterId] = useState(waiters[0]?.employeeId ?? "");
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!targetWaiterId && waiters.length > 0) setTargetWaiterId(waiters[0].employeeId);
  }, [waiters, targetWaiterId]);

  function toggle(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(orderId) ? next.delete(orderId) : next.add(orderId);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(myTables.map((t) => t.orderId)));
  }

  const selectedTables = myTables.filter((t) => selected.has(t.orderId));
  const targetWaiter = waiters.find((w) => w.employeeId === targetWaiterId);

  async function confirmHandoff() {
    if (!targetWaiterId) return;
    setBusy(true);
    onError(null);
    try {
      const result = await apiFetch("/api/pos/handover/transfer", {
        method: "POST",
        body: JSON.stringify({
          reason: selectedTables.length > 1 ? "SHIFT_HANDOVER" : "MANUAL_TABLE_TRANSFER",
          transfers: selectedTables.map((t) => ({ orderId: t.orderId, expectedPreviousOwnerId: myEmployeeId, newOwnerId: targetWaiterId })),
        }),
      });
      const n = result.succeeded.length;
      if (result.failed.length > 0) {
        onError(`${result.failed.length} sto${result.failed.length === 1 ? "" : "ova"} nije predato (izmenjeno u međuvremenu) — prikaz je osvežen.`);
      }
      onDone(n > 0 ? `Predao/la si ${n} sto${n === 1 ? "" : "ova"} konobaru ${targetWaiter?.employeeName ?? ""}.` : "Nijedan sto nije predat.");
      setSelected(new Set());
      setStep("select");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Greška pri predaji");
    } finally {
      setBusy(false);
    }
  }

  if (myTables.length === 0) {
    return <p className="rounded-md border border-line bg-white p-4 text-center text-sm text-ink/55">Nemaš otvorenih stolova za predaju.</p>;
  }
  if (waiters.length === 0) {
    return <p className="rounded-md border border-line bg-warn-soft p-4 text-center text-sm text-warn">Nema drugih aktivnih konobara na ovoj lokaciji.</p>;
  }

  if (step === "confirm") {
    return (
      <div>
        <div className="mb-3 rounded-md border border-line bg-white p-3">
          <p className="mb-2 text-sm font-semibold text-ink">
            Predaješ {selectedTables.length} sto{selectedTables.length === 1 ? "" : "ova"} konobaru <span className="text-gold-dark">{targetWaiter?.employeeName}</span>:
          </p>
          <ul className="space-y-1 text-sm text-ink/75">
            {selectedTables.map((t) => <li key={t.orderId} className="border-b border-line/50 py-1 last:border-0">{t.tableLabel}</li>)}
          </ul>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setStep("select")} className="flex-1 rounded-md border-2 border-line py-3 text-sm font-semibold text-ink">Nazad</button>
          <button
            onClick={confirmHandoff}
            disabled={busy}
            className="flex-1 rounded-md bg-graphite py-3 text-sm font-semibold text-cream-100 disabled:opacity-40"
          >
            {busy ? "Predaja…" : `Predaj ${selectedTables.length} stolova`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 rounded-md border border-line bg-white p-3">
        <label className="mb-1.5 block text-sm font-medium text-ink">Predaj konobaru</label>
        <select value={targetWaiterId} onChange={(e) => setTargetWaiterId(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-sm">
          {waiters.map((w) => <option key={w.employeeId} value={w.employeeId}>{w.employeeName}</option>)}
        </select>
      </div>
      <button onClick={selectAll} className="mb-3 w-full rounded-md border-2 border-gold-dark py-2.5 text-sm font-semibold text-gold-dark">
        Izaberi sve ({myTables.length})
      </button>
      <div className="space-y-1.5 rounded-md border border-line bg-white p-2">
        {myTables.map((t) => (
          <label key={t.orderId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 hover:bg-cream-100">
            <input type="checkbox" checked={selected.has(t.orderId)} onChange={() => toggle(t.orderId)} className="h-5 w-5 cursor-pointer accent-gold" />
            <span className="flex-1 text-sm text-ink">{t.tableLabel}</span>
            <span className="text-xs text-ink/50">{t.itemCount} stavki</span>
          </label>
        ))}
      </div>
      {selected.size > 0 && (
        <button
          onClick={() => setStep("confirm")}
          disabled={!targetWaiterId}
          className="fixed inset-x-4 bottom-4 rounded-md bg-graphite py-4 text-base font-semibold text-cream-100 shadow-elevated disabled:opacity-40 sm:static sm:mt-4"
        >
          Predaj {selected.size} sto{selected.size === 1 ? "" : "ova"}
        </button>
      )}
    </div>
  );
}

// ── MENADŽER: PRINUDNI TRANSFER ───────────────────────────────────────────

function ManagerPanel({
  overview,
  waiters,
  onDone,
  onError,
}: {
  overview: Overview | null;
  waiters: Waiter[];
  onDone: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [targetByOrder, setTargetByOrder] = useState<Record<string, string>>({});
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pending = overview?.pendingTables ?? [];
  const confirming = pending.find((t) => t.orderId === confirmingOrderId);

  async function confirmForceTransfer() {
    if (!confirming) return;
    const newOwnerId = targetByOrder[confirming.orderId];
    if (!newOwnerId) return;
    setBusy(true);
    onError(null);
    try {
      await apiFetch("/api/pos/handover/force-transfer", {
        method: "POST",
        body: JSON.stringify({ orderId: confirming.orderId, newOwnerId }),
      });
      const targetName = waiters.find((w) => w.employeeId === newOwnerId)?.employeeName ?? "";
      onDone(`Prinudno prebačen sto ${confirming.tableLabel} → ${targetName}.`);
      setConfirmingOrderId(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Greška pri prinudnom transferu");
    } finally {
      setBusy(false);
    }
  }

  if (pending.length === 0) {
    return <p className="rounded-md border border-line bg-white p-4 text-center text-sm text-ink/55">Nema otvorenih stolova koji čekaju transfer.</p>;
  }

  if (confirming) {
    const targetName = waiters.find((w) => w.employeeId === targetByOrder[confirming.orderId])?.employeeName ?? "";
    return (
      <div className="rounded-md border border-danger/30 bg-danger-soft p-3">
        <p className="mb-3 text-sm font-semibold text-danger">
          Prinudni transfer: sto {confirming.tableLabel} ({confirming.currentOwnerName} → {targetName})
        </p>
        <p className="mb-3 text-xs text-ink/70">Ova akcija se posebno evidentira kao MANAGER_FORCED_TRANSFER, sa tobom kao odobravaocem.</p>
        <div className="flex gap-2">
          <button onClick={() => setConfirmingOrderId(null)} className="flex-1 rounded-md border-2 border-line py-3 text-sm font-semibold text-ink">Otkaži</button>
          <button onClick={confirmForceTransfer} disabled={busy} className="flex-1 rounded-md bg-danger py-3 text-sm font-semibold text-white disabled:opacity-40">
            {busy ? "…" : "Potvrdi prinudni transfer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {pending.map((t) => (
        <div key={t.orderId} className="rounded-md border border-line bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">{t.tableLabel}</span>
            <span className="text-xs text-ink/55">trenutno: {t.currentOwnerName}</span>
          </div>
          <div className="flex gap-2">
            <select
              value={targetByOrder[t.orderId] ?? ""}
              onChange={(e) => setTargetByOrder((prev) => ({ ...prev, [t.orderId]: e.target.value }))}
              className="flex-1 rounded-md border border-line px-2 py-2 text-sm"
            >
              <option value="">Izaberi konobara…</option>
              {waiters.filter((w) => w.employeeId !== t.currentOwnerId).map((w) => <option key={w.employeeId} value={w.employeeId}>{w.employeeName}</option>)}
            </select>
            <button
              onClick={() => setConfirmingOrderId(t.orderId)}
              disabled={!targetByOrder[t.orderId]}
              className="rounded-md bg-danger px-3 py-2 text-sm font-semibold text-white disabled:opacity-30"
            >
              Prenesi
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
