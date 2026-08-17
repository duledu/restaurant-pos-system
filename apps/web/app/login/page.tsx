"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";
import { AppLogo } from "../../components/branding/AppLogo";
import { PinPad } from "../../components/auth/PinPad";
import { getDeviceId } from "../../lib/shared-pos";

type Mode = "pin" | "password";

export default function LoginPage() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("password");

  useEffect(() => {
    // Ovaj browser ima registrovan uređaj (packages/domain/devices,
    // /device-setup) — podrazumevani ekran je PIN tastatura, brže za
    // svakodnevni rad na deljenom/ličnom uređaju. Bez toga ostaje email
    // forma (identično ponašanje kao pre ove faze — nema regresije za
    // uređaje koji nikad nisu registrovani).
    const id = getDeviceId();
    setDeviceId(id);
    if (id) setMode("pin");
  }, []);

  return (
    <main className="flex min-h-screen min-h-[100dvh] w-full justify-center overflow-x-hidden bg-graphite px-4 pb-[clamp(1.5rem,6dvh,4rem)] pt-[clamp(2rem,10dvh,5rem)] sm:px-6">
      <div className="w-full max-w-sm animate-slide-up self-start">
        <header className="mb-[clamp(1.25rem,4dvh,1.75rem)] flex w-full flex-col items-center gap-3 text-center">
          <AppLogo theme="dark" size="lg" variant="mark" />
          <div className="flex flex-col items-center gap-1">
            <h1 className="whitespace-nowrap text-[clamp(1.5rem,7vw,1.75rem)] font-bold leading-tight tracking-[-0.02em]">
              <span className="text-white">Table</span>
              <span style={{ color: "#B3CFE5" }}>Core</span>
            </h1>
            <p
              className="whitespace-nowrap text-[clamp(0.5625rem,2.65vw,0.625rem)] font-medium uppercase tracking-[0.1em]"
              style={{ color: "rgba(179,207,229,0.65)" }}
            >
              Restaurant Control System
            </p>
          </div>
          <p className="w-full text-center text-sm leading-5 text-cream-300/70">
            {mode === "pin" ? "Unesite PIN" : "Prijava za osoblje restorana"}
          </p>
        </header>

        {mode === "pin" && deviceId ? (
          <PinLoginForm deviceId={deviceId} />
        ) : (
          <PasswordLoginForm />
        )}

        <div className="mt-5 text-center">
          {deviceId && (
            <button
              type="button"
              onClick={() => setMode((m) => (m === "pin" ? "password" : "pin"))}
              className="text-xs font-medium text-cream-300/60 hover:text-cream-300/90"
            >
              {mode === "pin" ? "Prijava sa email/lozinkom" : "Prijava sa PIN kodom"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function PinLoginForm({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, deviceId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Prijava nije uspela");
      router.push(body.redirectTo ?? "/login");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Neočekivana greška");
      setPin("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      {error && (
        <div className="mb-4 w-full rounded-sm bg-danger-soft px-3 py-2 text-center text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}
      <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={loading} />
    </div>
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
  const [email, setEmail] = useState("");
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
        body: JSON.stringify({ email, password }),
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
    <form onSubmit={submit} className="rounded-lg bg-white p-5 shadow-elevated sm:p-6">
      {error && (
        <div className="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}

      <div className="mb-4">
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium leading-5 text-inkSoft">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          className="h-11 w-full rounded-md border border-line px-3 text-base text-ink focus:border-gold focus:outline-none"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
