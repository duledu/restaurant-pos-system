"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { ROLE_LABEL, CREATE_ROLE_OPTIONS, EDIT_ROLE_OPTIONS } from "../../../components/admin/role-labels";

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  status: "ACTIVE" | "SUSPENDED" | "TERMINATED";
  hasPin: boolean;
  hasEncryptedPin: boolean;
  pinLoginEnabled: boolean;
  hasLoginCredentials: boolean;
  createdAt: string;
  roles: { role: { name: string } }[];
  locations: { location: { id: string; name: string } }[];
}
interface LocationOption {
  id: string;
  name: string;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const STATUS_LABEL: Record<Employee["status"], string> = { ACTIVE: "Aktivan", SUSPENDED: "Neaktivan", TERMINATED: "Uklonjen" };
const STATUS_TONE: Record<Employee["status"], "success" | "neutral" | "danger"> = {
  ACTIVE: "success",
  SUSPENDED: "neutral",
  TERMINATED: "danger",
};

function LocationPicker({
  locations,
  selected,
  onChange,
}: {
  locations: LocationOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {locations.map((loc) => (
        <label key={loc.id} className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={selected.includes(loc.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, loc.id] : selected.filter((id) => id !== loc.id))}
          />
          {loc.name}
        </label>
      ))}
      {locations.length === 0 && <p className="text-sm text-inkSoft">Nema dostupnih lokacija.</p>}
    </div>
  );
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

function AddEmployeeModal({
  locations,
  onCancel,
  onCreated,
}: {
  locations: LocationOption[];
  onCancel: () => void;
  onCreated: (name: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<(typeof CREATE_ROLE_OPTIONS)[number]>("WAITER");
  const [locationIds, setLocationIds] = useState<string[]>(locations.length === 1 ? [locations[0].id] : []);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pinValid = /^\d{4,6}$/.test(pin);
  const pinsMatch = pin === confirmPin;
  const canSubmit = firstName.trim() && lastName.trim() && locationIds.length > 0 && pinValid && pinsMatch;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/admin/employees", {
        method: "POST",
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), roleNames: [role], locationIds, pin }),
      });
      onCreated(`${firstName.trim()} ${lastName.trim()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju zaposlenog");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Dodaj zaposlenog" onCancel={onCancel}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Ime</label>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-base" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Prezime</label>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-base" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Rola</label>
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="w-full rounded-md border border-line px-3 py-2.5 text-base">
            {CREATE_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Lokacija</label>
          <LocationPicker locations={locations} selected={locationIds} onChange={setLocationIds} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-inkSoft">PIN</label>
            <input
              inputMode="numeric"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-md border border-line px-3 py-2.5 text-base tracking-widest"
              placeholder="••••"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-inkSoft">Potvrdi PIN</label>
            <input
              inputMode="numeric"
              type="password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-md border border-line px-3 py-2.5 text-base tracking-widest"
              placeholder="••••"
            />
          </div>
        </div>
        {pin && !pinValid && <p className="text-xs text-danger">PIN mora imati 4-6 cifara.</p>}
        {pin && confirmPin && !pinsMatch && <p className="text-xs text-danger">PIN-ovi se ne poklapaju.</p>}

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
            {submitting ? "Kreiranje…" : "Kreiraj zaposlenog"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function EditEmployeeModal({
  employee,
  locations,
  onCancel,
  onSaved,
}: {
  employee: Employee;
  locations: LocationOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(employee.firstName);
  const [lastName, setLastName] = useState(employee.lastName);
  const [role, setRole] = useState(employee.roles[0]?.role.name ?? "WAITER");
  const [locationIds, setLocationIds] = useState<string[]>(employee.locations.map((l) => l.location.id));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = firstName.trim() && lastName.trim() && locationIds.length > 0;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), roleNames: [role], locationIds }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri izmeni zaposlenog");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Izmeni zaposlenog" onCancel={onCancel}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Ime</label>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-base" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Prezime</label>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-base" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Rola</label>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full rounded-md border border-line px-3 py-2.5 text-base">
            {EDIT_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Lokacija</label>
          <LocationPicker locations={locations} selected={locationIds} onChange={setLocationIds} />
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
            {submitting ? "Čuvanje…" : "Sačuvaj izmene"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ChangePinModal({ employee, onCancel, onDone }: { employee: Employee; onCancel: () => void; onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pinValid = /^\d{4,6}$/.test(pin);
  const pinsMatch = pin === confirmPin;

  async function submit() {
    if (!pinValid || !pinsMatch || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/employees/${employee.id}/pin`, { method: "POST", body: JSON.stringify({ pin }) });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri promeni PIN-a");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title={`Promeni PIN — ${employee.firstName} ${employee.lastName}`} onCancel={onCancel}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Novi PIN</label>
          <input
            inputMode="numeric"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-md border border-line px-3 py-2.5 text-base tracking-widest"
            placeholder="••••"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Potvrdi novi PIN</label>
          <input
            inputMode="numeric"
            type="password"
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-md border border-line px-3 py-2.5 text-base tracking-widest"
            placeholder="••••"
          />
        </div>
        {pin && !pinValid && <p className="text-xs text-danger">PIN mora imati 4-6 cifara.</p>}
        {pin && confirmPin && !pinsMatch && <p className="text-xs text-danger">PIN-ovi se ne poklapaju.</p>}

        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

        <div className="flex gap-3 pt-2">
          <button onClick={onCancel} className="flex-1 rounded-md border border-line py-3 text-base font-medium text-ink">
            Otkaži
          </button>
          <button
            onClick={submit}
            disabled={!pinValid || !pinsMatch || submitting}
            className="flex-1 rounded-md bg-graphite py-3 text-base font-semibold text-cream-100 disabled:opacity-40"
          >
            {submitting ? "Čuvanje…" : "Sačuvaj novi PIN"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function RevealPinModal({ employee, onCancel }: { employee: Employee; onCancel: () => void }) {
  const [pin, setPin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/api/admin/employees/${employee.id}/pin`)
      .then((body: { pin: string }) => setPin(body.pin))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Greška pri otkrivanju PIN-a"))
      .finally(() => setLoading(false));
  }, [employee.id]);

  return (
    <ModalShell title={`PIN — ${employee.firstName} ${employee.lastName}`} onCancel={onCancel}>
      <div className="space-y-4">
        <p className="text-sm text-inkSoft">
          Ova radnja je zabeležena u evidenciji aktivnosti.
        </p>
        {loading && <div className="py-4 text-center text-sm text-inkSoft">Učitavanje…</div>}
        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        {pin !== null && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-center">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-700">PIN</p>
            <p className="text-3xl font-bold tracking-[0.3em] text-amber-900">{pin}</p>
          </div>
        )}
        <button
          onClick={onCancel}
          className="w-full rounded-md border border-line py-3 text-base font-medium text-ink"
        >
          Zatvori
        </button>
      </div>
    </ModalShell>
  );
}

function SetLoginCredentialsModal({ employee, onCancel, onDone }: { employee: Employee; onCancel: () => void; onDone: () => void }) {
  const [username, setUsername] = useState(employee.username ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameValid = username.trim().length >= 1;
  const passwordValid = password.length >= 10;
  const passwordsMatch = password === confirmPassword;
  const canSubmit = usernameValid && passwordValid && passwordsMatch;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/employees/${employee.id}/login-credentials`, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri postavljanju pristupnih podataka");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title={`Pristupni podaci — ${employee.firstName} ${employee.lastName}`} onCancel={onCancel}>
      <div className="space-y-3">
        {employee.hasLoginCredentials ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Ovaj zaposleni već ima pristupne podatke. Unosom novih podataka ispod postojeći će biti zamenjeni.
          </div>
        ) : (
          <p className="text-sm text-inkSoft">
            Postavi korisničko ime i lozinku da bi zaposleni mogao da registruje lični uređaj ili da se prijavi kao admin.
          </p>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Korisničko ime</label>
          <input
            type="text"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-md border border-line px-3 py-2.5 text-base"
            placeholder="npr. marko.petrovic"
          />
          {username && !usernameValid && <p className="mt-1 text-xs text-danger">Korisničko ime je obavezno.</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Nova lozinka</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-line px-3 py-2.5 pr-10 text-base"
              placeholder="najmanje 10 karaktera"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-inkSoft hover:text-ink"
              tabIndex={-1}
            >
              {showPassword ? "Sakrij" : "Pokaži"}
            </button>
          </div>
          {password && !passwordValid && <p className="mt-1 text-xs text-danger">Lozinka mora imati najmanje 10 karaktera.</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-inkSoft">Potvrdi lozinku</label>
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full rounded-md border border-line px-3 py-2.5 text-base"
            placeholder="ponovi lozinku"
          />
          {confirmPassword && !passwordsMatch && <p className="mt-1 text-xs text-danger">Lozinke se ne poklapaju.</p>}
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
            {submitting ? "Čuvanje…" : employee.hasLoginCredentials ? "Resetuj podatke" : "Postavi podatke"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function StaffClient() {
  const [staff, setStaff] = useState<Employee[] | null>(null);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [changingPin, setChangingPin] = useState<Employee | null>(null);
  const [revealingPin, setRevealingPin] = useState<Employee | null>(null);
  const [settingCredentials, setSettingCredentials] = useState<Employee | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffRes, locationsRes] = await Promise.all([
        apiFetch("/api/admin/employees"),
        apiFetch("/api/admin/employees/locations"),
      ]);
      setStaff(staffRes.employees);
      setLocations(locationsRes.locations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju osoblja");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleStatus(emp: Employee) {
    const nextStatus = emp.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    setBusyId(emp.id);
    setError(null);
    try {
      await apiFetch(`/api/admin/employees/${emp.id}/status`, { method: "POST", body: JSON.stringify({ status: nextStatus }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri promeni statusa");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePinLogin(emp: Employee) {
    setBusyId(emp.id);
    setError(null);
    try {
      await apiFetch(`/api/admin/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinLoginEnabled: !emp.pinLoginEnabled }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri promeni PIN prijave");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Osoblje</h1>
          <p className="mt-1 text-sm text-inkSoft">Konobari, kuhinja, šank i menadžment — nalozi za prijavu PIN-om</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-gold px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-dark"
        >
          Dodaj zaposlenog
        </button>
      </div>

      {notice && <div className="mb-4 rounded-md bg-success-soft px-4 py-3 text-sm text-success">{notice}</div>}
      {error && <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !staff ? (
        <Skeleton className="h-64" />
      ) : staff.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="Još nema zaposlenih." description="Dodaj prvog zaposlenog dugmetom iznad." />
        </Card>
      ) : (
        <>
          {/* ── Mobile: stacked cards ─────────────────────────────────────── */}
          <div className="space-y-3 md:hidden">
            {staff.map((emp) => (
              <Card key={emp.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink">
                      {emp.firstName} {emp.lastName}
                    </p>
                    <p className="mt-0.5 text-xs text-inkSoft">
                      {emp.roles.map((r) => ROLE_LABEL[r.role.name] ?? r.role.name).join(", ") || "—"}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[emp.status]}>{STATUS_LABEL[emp.status]}</Badge>
                </div>

                <div className="mt-3 space-y-1 text-sm text-inkSoft">
                  <p>
                    <span className="text-inkSoft/60">Korisničko ime: </span>
                    {emp.username ? <span className="font-mono text-xs">{emp.username}</span> : "—"}
                  </p>
                  <p>
                    <span className="text-inkSoft/60">Lokacija: </span>
                    {emp.locations.map((l) => l.location.name).join(", ") || "—"}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <span className="text-inkSoft/60">PIN prijava: </span>
                    {emp.hasPin ? (
                      <>
                        <span className="font-mono tracking-[0.2em]">••••</span>
                        {emp.hasEncryptedPin && (
                          <button onClick={() => setRevealingPin(emp)} title="Otkrij PIN" className="rounded p-0.5 text-inkSoft hover:text-ink">
                            <EyeIcon />
                          </button>
                        )}
                      </>
                    ) : (
                      <Badge tone="neutral">Nema PIN</Badge>
                    )}
                  </p>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-medium">
                  <button onClick={() => setEditing(emp)} className="rounded-md border border-line py-2.5 text-gold-dark">
                    Izmeni
                  </button>
                  <button onClick={() => setChangingPin(emp)} className="rounded-md border border-line py-2.5 text-gold-dark">
                    Promeni PIN
                  </button>
                  <button onClick={() => setSettingCredentials(emp)} className="rounded-md border border-line py-2.5 text-gold-dark">
                    {emp.hasLoginCredentials ? "Resetuj pristup" : "Postavi pristup"}
                  </button>
                  <button
                    onClick={() => togglePinLogin(emp)}
                    disabled={busyId === emp.id}
                    className={`rounded-md border border-line py-2.5 ${emp.pinLoginEnabled ? "text-inkSoft" : "text-success"}`}
                  >
                    {emp.pinLoginEnabled ? "Disable PIN" : "Enable PIN"}
                  </button>
                  <button
                    onClick={() => toggleStatus(emp)}
                    disabled={busyId === emp.id}
                    className={`col-span-2 rounded-md border py-2.5 ${
                      emp.status === "ACTIVE" ? "border-danger/30 text-danger" : "border-success/30 text-success"
                    }`}
                  >
                    {emp.status === "ACTIVE" ? "Deaktiviraj" : "Aktiviraj"}
                  </button>
                </div>
              </Card>
            ))}
          </div>

          {/* ── Desktop/tablet: table (unchanged) ────────────────────────── */}
          <Card className="hidden overflow-hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3 font-medium">Zaposleni</th>
                  <th className="px-4 py-3 font-medium">Korisničko ime</th>
                  <th className="px-4 py-3 font-medium">Rola</th>
                  <th className="px-4 py-3 font-medium">Lokacija</th>
                  <th className="px-4 py-3 font-medium">PIN</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {staff.map((emp) => (
                  <tr key={emp.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 font-medium text-ink">
                      {emp.firstName} {emp.lastName}
                    </td>
                    <td className="px-4 py-3 text-inkSoft">
                      {emp.username ? (
                        <span className="font-mono text-xs">{emp.username}</span>
                      ) : (
                        <span className="text-inkSoft/50">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-inkSoft">{emp.roles.map((r) => ROLE_LABEL[r.role.name] ?? r.role.name).join(", ")}</td>
                    <td className="px-4 py-3 text-inkSoft">{emp.locations.map((l) => l.location.name).join(", ") || "—"}</td>
                    <td className="px-4 py-3">
                      {emp.hasPin ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-sm tracking-[0.2em] text-inkSoft">••••</span>
                          {emp.hasEncryptedPin && (
                            <button
                              onClick={() => setRevealingPin(emp)}
                              title="Otkrij PIN"
                              className="rounded p-0.5 text-inkSoft hover:text-ink"
                            >
                              <EyeIcon />
                            </button>
                          )}
                        </div>
                      ) : (
                        <Badge tone="neutral">Nema PIN</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[emp.status]}>{STATUS_LABEL[emp.status]}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-3 whitespace-nowrap text-xs font-medium">
                        <button onClick={() => setEditing(emp)} className="text-gold-dark hover:underline">
                          Izmeni
                        </button>
                        <button onClick={() => setChangingPin(emp)} className="text-gold-dark hover:underline">
                          Promeni PIN
                        </button>
                        <button
                          onClick={() => togglePinLogin(emp)}
                          disabled={busyId === emp.id}
                          title={emp.pinLoginEnabled ? "Onemogući PIN prijavu za ovog zaposlenog" : "Omogući PIN prijavu za ovog zaposlenog"}
                          className={emp.pinLoginEnabled ? "text-inkSoft hover:underline" : "text-success hover:underline"}
                        >
                          {emp.pinLoginEnabled ? "Disable PIN" : "Enable PIN"}
                        </button>
                        <button onClick={() => setSettingCredentials(emp)} className="text-gold-dark hover:underline">
                          {emp.hasLoginCredentials ? "Resetuj pristup" : "Postavi pristup"}
                        </button>
                        <button
                          onClick={() => toggleStatus(emp)}
                          disabled={busyId === emp.id}
                          className={emp.status === "ACTIVE" ? "text-danger hover:underline" : "text-success hover:underline"}
                        >
                          {emp.status === "ACTIVE" ? "Deaktiviraj" : "Aktiviraj"}
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

      {showAdd && (
        <AddEmployeeModal
          locations={locations}
          onCancel={() => setShowAdd(false)}
          onCreated={(name) => {
            setShowAdd(false);
            setNotice(`${name} je kreiran/a i može da se prijavi svojim PIN-om.`);
            load();
          }}
        />
      )}
      {editing && (
        <EditEmployeeModal
          employee={editing}
          locations={locations}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice("Podaci zaposlenog su sačuvani.");
            load();
          }}
        />
      )}
      {changingPin && (
        <ChangePinModal
          employee={changingPin}
          onCancel={() => setChangingPin(null)}
          onDone={() => {
            setChangingPin(null);
            setNotice("PIN je uspešno promenjen.");
            load();
          }}
        />
      )}
      {revealingPin && (
        <RevealPinModal
          employee={revealingPin}
          onCancel={() => setRevealingPin(null)}
        />
      )}
      {settingCredentials && (
        <SetLoginCredentialsModal
          employee={settingCredentials}
          onCancel={() => setSettingCredentials(null)}
          onDone={() => {
            setSettingCredentials(null);
            setNotice("Pristupni podaci su uspešno postavljeni.");
            load();
          }}
        />
      )}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
