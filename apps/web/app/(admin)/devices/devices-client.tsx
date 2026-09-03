"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";

interface DeviceRow {
  id: string;
  name: string;
  deviceType: string;
  isShared: boolean;
  isActive: boolean;
  registeredAt: string;
  lastSeenAt: string | null;
  location: { id: string; name: string } | null;
  linkedEmployee: { id: string; name: string } | null;
  registeredBy: string | null;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("sr-RS", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtLastSeen(iso: string | null) {
  if (!iso) return "Nikad";
  return new Date(iso).toLocaleString("sr-RS", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ModalShell({ title, onCancel, children }: { title: string; onCancel: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" onClick={onCancel}>
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-t-lg bg-white p-5 shadow-elevated sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function RenameDeviceModal({ device, onCancel, onDone }: { device: DeviceRow; onCancel: () => void; onDone: () => void }) {
  const [name, setName] = useState(device.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri preimenovanju uređaja");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Preimenuj uređaj" onCancel={onCancel}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Naziv uređaja</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-line px-3 py-2.5 text-base"
            maxLength={100}
          />
        </div>
        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        <div className="flex gap-3 pt-2">
          <button onClick={onCancel} className="flex-1 rounded-md border border-line py-3 text-base font-medium text-ink">
            Otkaži
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-1 rounded-md bg-graphite py-3 text-base font-semibold text-cream-100 disabled:opacity-40"
          >
            {submitting ? "Čuvanje…" : "Sačuvaj"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function DevicesClient() {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<DeviceRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/devices");
      setDevices(res.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju uređaja");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleStatus(device: DeviceRow) {
    setBusyId(device.id);
    setError(null);
    try {
      await apiFetch(`/api/admin/devices/${device.id}/status`, {
        method: "POST",
        body: JSON.stringify({ isActive: !device.isActive }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri promeni statusa uređaja");
    } finally {
      setBusyId(null);
    }
  }

  // Klijentska pretraga po nazivu uređaja, lokaciji ili povezanom zaposlenom
  // — case-insensitive, isti obrazac kao Osoblje/Zalihe pretraga. Lista je
  // već skopirana na restoran (listDevices/scopeToRestaurant); filtriranje
  // ovde je samo prikaz.
  const filtered = useMemo(() => {
    if (!devices) return devices;
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) => {
      return (
        d.name.toLowerCase().includes(q) ||
        (d.location?.name.toLowerCase().includes(q) ?? false) ||
        (d.linkedEmployee?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [devices, search]);

  return (
    <div className="w-full">
      <PageHeader title="Uređaji" description="Deljeni POS terminali i lični uređaji osoblja — pregled i upravljanje" />

      {notice && <div className="mb-4 rounded-md bg-success-soft px-4 py-3 text-sm text-success">{notice}</div>}
      {error && <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !devices ? (
        <Skeleton className="h-64" />
      ) : devices.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            title="Još nema registrovanih uređaja."
            description="Uređaji se registruju sa samog terminala/telefona kroz 'Uređaji' podešavanje ili prijavu ličnim nalogom."
          />
        </Card>
      ) : (
        <>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pretraga po nazivu, lokaciji ili zaposlenom…"
            className="mb-4 w-full max-w-sm rounded-md border border-line px-3 py-2.5 text-base placeholder:text-ink/35 sm:text-sm"
          />

          {filtered && filtered.length === 0 ? (
            <Card className="p-5">
              <EmptyState title="Nema rezultata pretrage" description="Pokušaj drugi naziv, lokaciju ili zaposlenog." />
            </Card>
          ) : (
            <>
              {/* ── Mobile: stacked cards ─────────────────────────────────── */}
              <div className="space-y-3 md:hidden">
                {filtered?.map((d) => (
                  <Card key={d.id} className="overflow-hidden border-l-[3px] border-l-gold p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-ink">{d.name}</p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-inkSoft">
                          <Badge tone={d.isShared ? "neutral" : "success"}>{d.isShared ? "Deljeni POS" : "Lični uređaj"}</Badge>
                        </p>
                      </div>
                      <Badge tone={d.isActive ? "success" : "danger"}>{d.isActive ? "Aktivan" : "Opozvan"}</Badge>
                    </div>

                    <div className="mt-3 space-y-1 text-sm text-inkSoft">
                      <p>
                        <span className="text-inkSoft/60">Lokacija: </span>
                        {d.location?.name ?? "—"}
                      </p>
                      {d.linkedEmployee && (
                        <p>
                          <span className="text-inkSoft/60">Zaposleni: </span>
                          {d.linkedEmployee.name}
                        </p>
                      )}
                      <p>
                        <span className="text-inkSoft/60">Registrovan: </span>
                        {fmtDate(d.registeredAt)}
                        {d.registeredBy ? ` — ${d.registeredBy}` : ""}
                      </p>
                      <p>
                        <span className="text-inkSoft/60">Poslednja aktivnost: </span>
                        {fmtLastSeen(d.lastSeenAt)}
                      </p>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-medium">
                      <button onClick={() => setRenaming(d)} className="rounded-md border border-line py-2.5 text-gold-dark">
                        Preimenuj
                      </button>
                      <button
                        onClick={() => toggleStatus(d)}
                        disabled={busyId === d.id}
                        className={`rounded-md border py-2.5 ${d.isActive ? "border-danger/30 text-danger" : "border-success/30 text-success"}`}
                      >
                        {d.isActive ? "Opozovi" : "Aktiviraj"}
                      </button>
                    </div>
                  </Card>
                ))}
              </div>

              {/* ── Desktop/tablet: table ──────────────────────────────────── */}
              <Card className="hidden overflow-hidden md:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                        <th className="px-4 py-3 font-medium">Uređaj</th>
                        <th className="px-4 py-3 font-medium">Tip</th>
                        <th className="px-4 py-3 font-medium">Lokacija</th>
                        <th className="px-4 py-3 font-medium">Zaposleni</th>
                        <th className="px-4 py-3 font-medium">Registrovan</th>
                        <th className="px-4 py-3 font-medium">Poslednja aktivnost</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered?.map((d) => (
                        <tr key={d.id} className="border-b border-line last:border-0">
                          <td className="px-4 py-3 font-medium text-ink">{d.name}</td>
                          <td className="px-4 py-3">
                            <Badge tone={d.isShared ? "neutral" : "success"}>{d.isShared ? "Deljeni POS" : "Lični uređaj"}</Badge>
                          </td>
                          <td className="px-4 py-3 text-inkSoft">{d.location?.name ?? "—"}</td>
                          <td className="px-4 py-3 text-inkSoft">{d.linkedEmployee?.name ?? "—"}</td>
                          <td className="px-4 py-3 text-inkSoft">
                            {fmtDate(d.registeredAt)}
                            {d.registeredBy && <span className="block text-xs text-inkSoft/60">{d.registeredBy}</span>}
                          </td>
                          <td className="px-4 py-3 text-inkSoft">{fmtLastSeen(d.lastSeenAt)}</td>
                          <td className="px-4 py-3">
                            <Badge tone={d.isActive ? "success" : "danger"}>{d.isActive ? "Aktivan" : "Opozvan"}</Badge>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-3 whitespace-nowrap text-xs font-medium">
                              <button onClick={() => setRenaming(d)} className="inline-flex min-h-11 items-center px-1 text-gold-dark hover:underline">
                                Preimenuj
                              </button>
                              <button
                                onClick={() => toggleStatus(d)}
                                disabled={busyId === d.id}
                                className={`inline-flex min-h-11 items-center px-1 ${d.isActive ? "text-danger hover:underline" : "text-success hover:underline"}`}
                              >
                                {d.isActive ? "Opozovi" : "Aktiviraj"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}

      {renaming && (
        <RenameDeviceModal
          device={renaming}
          onCancel={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            setNotice("Naziv uređaja je sačuvan.");
            load();
          }}
        />
      )}
    </div>
  );
}
