"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TableRow {
  id: string;
  label: string;
  capacity: number;
  status: string;
  isActive: boolean;
}

interface FloorRow {
  id: string;
  name: string;
  sortOrder: number;
  tables: TableRow[];
}

interface LocationOption {
  id: string;
  name: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const inputClass =
  "w-full rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-ink/35 focus:border-gold focus:outline-none";

// ─── Modal shell ──────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-slide-up rounded-lg bg-white shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Zatvori"
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink/50 hover:bg-ink/[.05] hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Floor modals ─────────────────────────────────────────────────────────────

function CreateFloorModal({
  locationId,
  onClose,
  onDone,
}: {
  locationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { setErr("Naziv sale je obavezan"); return; }
    setLoading(true); setErr("");
    try {
      await apiFetch("/api/admin/tables/floors", {
        method: "POST",
        body: JSON.stringify({ locationId, name: name.trim() }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setLoading(false); }
  }

  return (
    <Modal title="Dodaj salu" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink">Naziv sale</label>
      <input
        autoFocus
        className={`mb-1 ${inputClass}`}
        placeholder="npr. Glavna sala, Terasa, Bašta…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button onClick={submit} loading={loading} disabled={!name.trim()}>
          {loading ? "Čuvanje…" : "Sačuvaj salu"}
        </Button>
      </div>
    </Modal>
  );
}

function EditFloorModal({
  floor,
  onClose,
  onDone,
}: {
  floor: FloorRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(floor.name);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { setErr("Naziv sale je obavezan"); return; }
    setLoading(true); setErr("");
    try {
      await apiFetch(`/api/admin/tables/floors/${floor.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setLoading(false); }
  }

  return (
    <Modal title="Uredi salu" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink">Naziv sale</label>
      <input
        autoFocus
        className={`mb-1 ${inputClass}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button onClick={submit} loading={loading} disabled={!name.trim()}>
          {loading ? "Čuvanje…" : "Sačuvaj"}
        </Button>
      </div>
    </Modal>
  );
}

// ─── Table modals ─────────────────────────────────────────────────────────────

function CreateTableModal({
  floor,
  allFloors,
  onClose,
  onDone,
}: {
  floor: FloorRow;
  allFloors: FloorRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [floorId, setFloorId] = useState(floor.id);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!label.trim()) { setErr("Naziv stola je obavezan"); return; }
    const cap = parseInt(capacity, 10);
    if (!cap || cap < 1) { setErr("Unesite validan broj mesta"); return; }
    setLoading(true); setErr("");
    try {
      await apiFetch("/api/admin/tables", {
        method: "POST",
        body: JSON.stringify({ floorId, label: label.trim(), capacity: cap }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setLoading(false); }
  }

  return (
    <Modal title="Dodaj sto" onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink">Naziv stola</label>
      <input
        autoFocus
        className={`mb-3 ${inputClass}`}
        placeholder="npr. Sto 1, VIP 1, Bašta 4…"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <label className="mb-1 block text-sm font-medium text-ink">Broj mesta</label>
      <input
        type="number"
        min={1}
        max={999}
        className={`mb-3 ${inputClass}`}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
      />
      <label className="mb-1 block text-sm font-medium text-ink">Sala</label>
      <select
        className={`mb-3 ${inputClass}`}
        value={floorId}
        onChange={(e) => setFloorId(e.target.value)}
      >
        {allFloors.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button onClick={submit} loading={loading} disabled={!label.trim()}>
          {loading ? "Čuvanje…" : "Dodaj sto"}
        </Button>
      </div>
    </Modal>
  );
}

function EditTableModal({
  table,
  allFloors,
  onClose,
  onDone,
}: {
  table: TableRow & { floorId: string };
  allFloors: FloorRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(table.label);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [floorId, setFloorId] = useState(table.floorId);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!label.trim()) { setErr("Naziv stola je obavezan"); return; }
    const cap = parseInt(capacity, 10);
    if (!cap || cap < 1) { setErr("Unesite validan broj mesta"); return; }
    setLoading(true); setErr("");
    try {
      await apiFetch(`/api/admin/tables/${table.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: label.trim(),
          capacity: cap,
          floorId: floorId !== table.floorId ? floorId : undefined,
        }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setLoading(false); }
  }

  return (
    <Modal title={`Uredi sto — ${table.label}`} onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink">Naziv stola</label>
      <input
        autoFocus
        className={`mb-3 ${inputClass}`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <label className="mb-1 block text-sm font-medium text-ink">Broj mesta</label>
      <input
        type="number"
        min={1}
        max={999}
        className={`mb-3 ${inputClass}`}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
      />
      <label className="mb-1 block text-sm font-medium text-ink">Sala</label>
      <select
        className={`mb-3 ${inputClass}`}
        value={floorId}
        onChange={(e) => setFloorId(e.target.value)}
      >
        {allFloors.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button onClick={submit} loading={loading} disabled={!label.trim()}>
          {loading ? "Čuvanje…" : "Sačuvaj"}
        </Button>
      </div>
    </Modal>
  );
}

function DeactivateTableModal({
  table,
  onClose,
  onDone,
}: {
  table: TableRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function confirm() {
    setLoading(true); setErr("");
    try {
      await apiFetch(`/api/admin/tables/${table.id}/deactivate`, { method: "POST" });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setLoading(false); }
  }

  return (
    <Modal title="Deaktiviraj sto" onClose={onClose}>
      <p className="mb-4 text-sm text-inkSoft">
        Deaktiviran sto <strong className="text-ink">{table.label}</strong> više neće biti dostupan
        konobarima za nove porudžbine. Istorija postojećih porudžbina će biti sačuvana.
      </p>
      {err && (
        <div className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button variant="danger" onClick={confirm} loading={loading}>
          {loading ? "Deaktiviranje…" : "Deaktiviraj"}
        </Button>
      </div>
    </Modal>
  );
}

// ─── Table card ───────────────────────────────────────────────────────────────

function TableCard({
  table,
  floorId,
  allFloors,
  onRefresh,
}: {
  table: TableRow;
  floorId: string;
  allFloors: FloorRow[];
  onRefresh: () => void;
}) {
  type ModalT = "edit" | "deactivate" | null;
  const [modal, setModal] = useState<ModalT>(null);
  const [activating, setActivating] = useState(false);
  const [err, setErr] = useState("");

  async function handleActivate() {
    setActivating(true); setErr("");
    try {
      await apiFetch(`/api/admin/tables/${table.id}/activate`, { method: "POST" });
      onRefresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Greška"); }
    finally { setActivating(false); }
  }

  return (
    <>
      <div
        className={`flex flex-col gap-2 rounded-lg border p-3 transition-colors ${
          table.isActive
            ? "border-line bg-white hover:border-gold/40"
            : "border-line/50 bg-ink/[0.02] opacity-60"
        }`}
      >
        <div className="flex items-start justify-between gap-1">
          <span className="font-semibold text-ink leading-tight">{table.label}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            table.isActive
              ? "bg-success-soft text-success"
              : "bg-ink/[0.07] text-inkSoft"
          }`}>
            {table.isActive ? "Aktivan" : "Neaktivan"}
          </span>
        </div>
        <p className="text-xs text-inkSoft">{table.capacity} {table.capacity === 1 ? "mesto" : "mesta"}</p>
        {err && <p className="text-xs text-danger">{err}</p>}
        <div className="flex gap-1.5 pt-1">
          {table.isActive ? (
            <>
              <button
                onClick={() => setModal("edit")}
                className="min-h-9 flex-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-inkSoft hover:bg-ink/[.04] hover:text-ink transition-colors"
              >
                Uredi
              </button>
              <button
                onClick={() => setModal("deactivate")}
                className="min-h-9 rounded-md border border-danger/20 px-2 py-1 text-xs font-medium text-danger/70 hover:bg-danger-soft hover:text-danger transition-colors"
              >
                Deakt.
              </button>
            </>
          ) : (
            <button
              onClick={handleActivate}
              disabled={activating}
              className="min-h-9 flex-1 rounded-md border border-success/30 px-2 py-1 text-xs font-medium text-success hover:bg-success-soft transition-colors disabled:opacity-40"
            >
              {activating ? "…" : "Aktiviraj"}
            </button>
          )}
        </div>
      </div>

      {modal === "edit" && (
        <EditTableModal
          table={{ ...table, floorId }}
          allFloors={allFloors}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onRefresh(); }}
        />
      )}
      {modal === "deactivate" && (
        <DeactivateTableModal
          table={table}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onRefresh(); }}
        />
      )}
    </>
  );
}

// ─── Floor card ───────────────────────────────────────────────────────────────

function FloorCard({
  floor,
  allFloors,
  onRefresh,
}: {
  floor: FloorRow;
  allFloors: FloorRow[];
  onRefresh: () => void;
}) {
  type ModalT = "editFloor" | "createTable" | null;
  const [modal, setModal] = useState<ModalT>(null);

  const activeCount = floor.tables.filter((t) => t.isActive).length;
  const totalCount = floor.tables.length;

  return (
    <>
      <Card className="overflow-hidden">
        {/* Floor header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-ink/[0.015] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-ink">{floor.name}</h2>
            <p className="text-xs text-inkSoft">
              {activeCount} {activeCount === 1 ? "aktivan sto" : "aktivnih stolova"}
              {totalCount > activeCount && ` · ${totalCount - activeCount} neaktivnih`}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModal("editFloor")}>
              Uredi salu
            </Button>
            <Button size="sm" onClick={() => setModal("createTable")}>
              + Dodaj sto
            </Button>
          </div>
        </div>

        {/* Table grid */}
        <div className="p-4">
          {floor.tables.length === 0 ? (
            <div className="py-4 text-center">
              <p className="text-sm text-inkSoft">Nema stolova u ovoj sali.</p>
              <button
                onClick={() => setModal("createTable")}
                className="mt-2 text-sm font-medium text-gold hover:text-gold-dark"
              >
                Dodaj prvi sto →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {floor.tables.map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  floorId={floor.id}
                  allFloors={allFloors}
                  onRefresh={onRefresh}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      {modal === "editFloor" && (
        <EditFloorModal
          floor={floor}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onRefresh(); }}
        />
      )}
      {modal === "createTable" && (
        <CreateTableModal
          floor={floor}
          allFloors={allFloors}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onRefresh(); }}
        />
      )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TablesClient() {
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [floors, setFloors] = useState<FloorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateFloor, setShowCreateFloor] = useState(false);

  // Load locations once on mount
  useEffect(() => {
    fetch("/api/admin/locations")
      .then((r) => r.json())
      .then((j) => {
        const locs: LocationOption[] = j.locations ?? [];
        setLocations(locs);
        if (locs.length > 0) setLocationId(locs[0].id);
      })
      .catch(() => setError("Greška pri učitavanju lokacija"));
  }, []);

  // Load floors whenever location changes
  const loadFloors = useCallback(() => {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/tables/floors?locationId=${locationId}`)
      .then((r) => r.json())
      .then((j) => setFloors(j.floors ?? []))
      .catch(() => setError("Greška pri učitavanju sala"))
      .finally(() => setLoading(false));
  }, [locationId]);

  useEffect(() => { loadFloors(); }, [loadFloors]);

  const selectedLocation = locations.find((l) => l.id === locationId);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sale i stolovi"
        description="Upravljanje rasporedom sala i stolova"
        actions={
          <Button onClick={() => setShowCreateFloor(true)} size="md">
            + Dodaj salu
          </Button>
        }
      />

      {/* Location selector */}
      {locations.length > 1 && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line/80 bg-white p-3 shadow-sm">
          <span className="text-sm font-medium text-ink">Lokacija:</span>
          <select
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-none"
            value={locationId ?? ""}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      )}

      {locations.length === 1 && selectedLocation && (
        <p className="mb-5 text-sm text-inkSoft">
          Lokacija: <strong className="text-ink">{selectedLocation.name}</strong>
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="mb-3 h-6 w-40" />
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {Array.from({ length: 6 }).map((_, j) => (
                  <Skeleton key={j} className="h-24 w-full rounded-lg" />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && floors.length === 0 && (
        <Card className="p-10 text-center">
          <EmptyState
            title="Još nema sala"
            description="Dodajte prvu salu, a zatim stolove koje će konobari koristiti za porudžbine."
          />
          <div className="mt-5">
            <Button onClick={() => setShowCreateFloor(true)}>
              Dodaj prvu salu
            </Button>
          </div>
        </Card>
      )}

      {/* Floor cards */}
      {!loading && !error && floors.length > 0 && (
        <div className="space-y-4">
          {floors.map((floor) => (
            <FloorCard
              key={floor.id}
              floor={floor}
              allFloors={floors}
              onRefresh={loadFloors}
            />
          ))}
        </div>
      )}

      {/* Create floor modal */}
      {showCreateFloor && locationId && (
        <CreateFloorModal
          locationId={locationId}
          onClose={() => setShowCreateFloor(false)}
          onDone={() => { setShowCreateFloor(false); loadFloors(); }}
        />
      )}
    </div>
  );
}
