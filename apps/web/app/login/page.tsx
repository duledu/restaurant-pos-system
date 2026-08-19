"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";
import { AppLogo } from "../../components/branding/AppLogo";
import { PinPad } from "../../components/auth/PinPad";
import { clearDevice, getDeviceId } from "../../lib/shared-pos";
import { ROLE_LABEL } from "../../components/admin/role-labels";

// Tri stanja prijave:
// "admin"            – email + lozinka (OWNER/ADMIN/MANAGER)
// "staff"            – PIN sa imenikom zaposlenih (registrovani deljeni terminal)
// "personal-device"  – lični uređaj (PIN zaposlenog, nema imenika osim njega)
// "register-personal"– forma za prvi put registrovanje ličnog uređaja
type Mode = "admin" | "staff" | "personal-device" | "register-personal";

interface StaffEntry {
  id: string;
  name: string;
  role: string | null;
}

export default function LoginPage() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("admin");

  useEffect(() => {
    const id = getDeviceId();
    setDeviceId(id);
    if (id) {
      // Device registered — let StaffLoginForm figure out shared vs personal
      // based on staff-directory response (1 entry = personal)
      setMode("staff");
    }
  }, []);

  function handlePersonalRegistered(newDeviceId: string) {
    setDeviceId(newDeviceId);
    // Keep mode="staff" — StaffLoginForm will load the single-employee view
    setMode("staff");
  }

  function handleDeviceInvalid() {
    // Server odgovorio 403 — deviceId u localStorage-u više ne postoji u bazi.
    // Obrišemo zastareli localStorage i prebacimo na admin prijavu.
    clearDevice();
    setDeviceId(null);
    setMode("admin");
  }

  return (
    <main className="relative flex min-h-screen min-h-[100dvh] w-full justify-center overflow-x-hidden bg-[radial-gradient(circle_at_50%_-10%,#1A4A73_0%,#0A1931_38%,#06111E_100%)] px-4 pb-[clamp(1.5rem,6dvh,4rem)] pt-[clamp(1.5rem,7dvh,4rem)] sm:px-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cream-300/60 to-transparent" />
      <div className="w-full max-w-[420px] animate-slide-up self-start">
        <header className="mb-[clamp(1.25rem,4dvh,2rem)] flex w-full flex-col items-center gap-3 text-center">
          <AppLogo theme="dark" size="lg" variant="mark" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-[clamp(1.5rem,7vw,1.75rem)] font-bold leading-tight tracking-[-0.02em]">
              <span className="text-white">Table</span>
              <span style={{ color: "#B3CFE5" }}>Core</span>
            </h1>
            <p
              className="text-[clamp(0.5625rem,2.65vw,0.625rem)] font-medium uppercase tracking-[0.08em]"
              style={{ color: "rgba(179,207,229,0.65)" }}
            >
              Restaurant Control System
            </p>
          </div>
          <div className="mt-1 flex max-w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
            <p className="text-center text-[11px] font-medium leading-4 text-cream-300/75">Bezbedan pristup · zajednički POS terminal</p>
          </div>
        </header>

        {/* Registered device — shared POS or personal device (StaffLoginForm handles both) */}
        {deviceId && mode === "staff" && <StaffLoginForm deviceId={deviceId} onDeviceInvalid={handleDeviceInvalid} />}

        {/* Admin email login */}
        {mode === "admin" && <PasswordLoginForm />}

        {/* Personal device first-time registration */}
        {mode === "register-personal" && (
          <PersonalDeviceRegistrationForm
            onRegistered={handlePersonalRegistered}
            onCancel={() => setMode("admin")}
          />
        )}

        {/* Footer links */}
        <div className="mt-5 space-y-2 text-center">
          {deviceId && mode === "staff" && (
            <button
              type="button"
              onClick={() => setMode("admin")}
              className="text-xs font-medium text-cream-300/60 hover:text-cream-300/90"
            >
              Administratorska prijava
            </button>
          )}
          {mode === "admin" && (
            <div className="space-y-1.5">
              {deviceId ? (
                <button
                  type="button"
                  onClick={() => setMode("staff")}
                  className="block w-full px-2 text-xs font-medium leading-5 text-cream-300/60 hover:text-cream-300/90"
                >
                  ← Prijava za osoblje
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setMode("register-personal")}
                  className="block w-full px-2 text-xs font-medium leading-5 text-cream-300/60 hover:text-cream-300/90"
                >
                  Prijava zaposlenog (lični uređaj) →
                </button>
              )}
            </div>
          )}
          {mode === "register-personal" && (
            <button
              type="button"
              onClick={() => setMode("admin")}
              className="text-xs font-medium text-cream-300/60 hover:text-cream-300/90"
            >
              ← Administratorska prijava
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function StaffLoginForm({ deviceId, onDeviceInvalid }: { deviceId: string; onDeviceInvalid: () => void }) {
  const router = useRouter();
  const [staff, setStaff] = useState<StaffEntry[] | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/auth/staff-directory?deviceId=${encodeURIComponent(deviceId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          // 403 = uređaj nije u bazi (zastareli localStorage) — obriši i prebaci
          // na admin prijavu umesto prikazivanja greške na stranom ekranu.
          if (res.status === 403 && !cancelled) {
            onDeviceInvalid();
            return;
          }
          throw new Error(body.error ?? "Greška pri učitavanju osoblja");
        }
        if (cancelled) return;
        const list = body.staff as StaffEntry[];
        setStaff(list);
        if (list.length > 0) setEmployeeId(list[0].id);
      })
      .catch((e) => !cancelled && setStaffError(e instanceof Error ? e.message : "Greška"));
    return () => {
      cancelled = true;
    };
  }, [deviceId, onDeviceInvalid]);

  const selected = staff?.find((s) => s.id === employeeId) ?? null;

  async function submit() {
    if (loading || !employeeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, pin, deviceId }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error("PIN nije ispravan. Pokušajte ponovo.");
        if (res.status === 423 || res.status === 429) throw new Error("Previše neuspešnih pokušaja. Pokušajte ponovo kasnije.");
        throw new Error(body.error ?? "Prijava nije uspela");
      }
      router.push(body.redirectTo ?? "/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neočekivana greška");
      setPin("");
    } finally {
      setLoading(false);
    }
  }

  if (staffError) {
    return <div className="rounded-sm bg-danger-soft px-3 py-2 text-center text-sm text-danger">{staffError}</div>;
  }

  // Lični uređaj — 1 zaposleni, ne prikazuj dropdown
  const isPersonalDevice = staff !== null && staff.length === 1;

  return (
    <div className="flex flex-col items-center">
      <div className="mb-5 w-full rounded-lg border border-white/50 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,.28)]">
        {isPersonalDevice && selected ? (
          // Lični uređaj: prikaži samo ime, bez imenika
          <div>
            <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-inkSoft">Zaposleni</p>
            <p className="text-base font-semibold text-ink">{selected.name}</p>
            {selected.role && <p className="mt-0.5 text-sm text-inkSoft">{ROLE_LABEL[selected.role] ?? selected.role}</p>}
          </div>
        ) : (
          // Deljeni terminal: prikaži dropdown sa imenikom
          <>
            <label htmlFor="employee" className="mb-1.5 block text-sm font-medium text-inkSoft">
              Zaposleni
            </label>
            <select
              id="employee"
              className="h-14 w-full rounded-md border border-line px-3 text-base text-ink focus:border-gold focus:outline-none"
              value={employeeId}
              disabled={!staff || staff.length === 0}
              onChange={(e) => {
                setEmployeeId(e.target.value);
                setPin("");
                setError(null);
              }}
            >
              {!staff && <option>Učitavanje…</option>}
              {staff?.length === 0 && <option>Nema dostupnog osoblja</option>}
              {staff?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {selected?.role && <p className="mt-1.5 text-sm text-inkSoft">{ROLE_LABEL[selected.role] ?? selected.role}</p>}
          </>
        )}
      </div>

      {error && (
        <div className="mb-4 w-full rounded-sm bg-danger-soft px-3 py-2 text-center text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}

      <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={loading || !employeeId} />
    </div>
  );
}

function PersonalDeviceRegistrationForm({
  onRegistered,
  onCancel,
}: {
  onRegistered: (deviceId: string) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/device/personal-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Registracija nije uspela");
      // Store deviceId in localStorage (same mechanism as shared POS setup)
      const { setDeviceId } = await import("../../lib/shared-pos");
      setDeviceId(body.deviceId);
      onRegistered(body.deviceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-white/50 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,.28)] sm:p-6">
      <p className="mb-4 text-sm text-inkSoft">
        Unesite vaše korisničke podatke koje je postavio administrator. Ovaj telefon/tablet
        biće registrovan kao vaš lični uređaj za PIN prijavu.
      </p>

      {error && (
        <div className="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="personal-username" className="mb-1.5 block text-sm font-medium leading-5 text-inkSoft">
          Korisničko ime
        </label>
        <input
          id="personal-username"
          type="text"
          autoComplete="username"
          required
          suppressHydrationWarning
          className="h-11 w-full rounded-md border border-line px-3 text-base text-ink focus:border-gold focus:outline-none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>

      <div className="mb-5">
        <label htmlFor="personal-password" className="mb-1.5 block text-sm font-medium leading-5 text-inkSoft">
          Lozinka
        </label>
        <div className="relative">
          <input
            id="personal-password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            suppressHydrationWarning
            className="h-11 w-full rounded-md border border-line px-3 pr-11 text-base text-ink focus:border-gold focus:outline-none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-controls="personal-password"
            aria-pressed={showPassword}
            aria-label={showPassword ? "Sakrij lozinku" : "Prikaži lozinku"}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center rounded-r-md text-inkSoft transition-colors hover:text-ink"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="h-12 w-full py-0">
        {loading ? "Registrovanje…" : "Registruj lični uređaj"}
      </Button>
    </form>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function PasswordLoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Prijava nije uspela");
      router.push(body.redirectTo ?? "/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-white/50 bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,.28)] sm:p-6">
      {error && (
        <div className="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium leading-5 text-inkSoft">
          Korisničko ime
        </label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          required
          suppressHydrationWarning
          className="h-11 w-full rounded-md border border-line px-3 text-base text-ink focus:border-gold focus:outline-none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>

      <div className="mb-5">
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium leading-5 text-inkSoft">
          Lozinka
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            suppressHydrationWarning
            className="h-11 w-full rounded-md border border-line px-3 pr-11 text-base text-ink focus:border-gold focus:outline-none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-controls="password"
            aria-pressed={showPassword}
            aria-label={showPassword ? "Sakrij lozinku" : "Prikaži lozinku"}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center rounded-r-md text-inkSoft transition-colors hover:text-ink"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="h-12 w-full py-0">
        {loading ? "Prijavljivanje…" : "Prijavi se"}
      </Button>
    </form>
  );
}
