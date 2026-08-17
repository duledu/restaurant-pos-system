"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";
import { AppLogo } from "../../components/branding/AppLogo";

export default function LoginPage() {
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
    <main className="flex min-h-screen min-h-[100dvh] w-full justify-center overflow-x-hidden bg-graphite px-4 pb-[clamp(1.5rem,6dvh,4rem)] pt-[clamp(2rem,10dvh,5rem)] sm:px-6">
      <div className="w-full max-w-sm animate-slide-up self-start">
        {/* Logo */}
        <header className="mb-[clamp(1.25rem,4dvh,1.75rem)] flex w-full flex-col items-center gap-2.5 text-center">
          <AppLogo theme="dark" size="lg" variant="full" className="mx-auto justify-center" />
          <p className="w-full text-center text-sm leading-5 text-cream-300/70">Prijava za osoblje restorana</p>
        </header>

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
                className="h-11 w-full rounded-md border border-line px-3 pr-20 text-base text-ink focus:border-gold focus:outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-controls="password"
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex min-h-11 items-center rounded-r-md px-3 text-sm font-medium text-inkSoft transition-colors hover:text-ink"
              >
                {showPassword ? "Sakrij" : "Prikaži"}
              </button>
            </div>
          </div>

          <Button type="submit" variant="primary" size="lg" loading={loading} className="h-12 w-full py-0">
            {loading ? "Prijavljivanje…" : "Prijavi se"}
          </Button>
        </form>

        {process.env.NODE_ENV === "development" && <DevTestAccounts />}
      </div>
    </main>
  );
}

function DevTestAccounts() {
  return (
    <div className="mt-6 rounded-md border border-cream-300/15 bg-white/5 p-4 text-xs text-cream-300/60">
      <p className="mb-2 font-medium text-cream-300/80">Test nalozi (samo development)</p>
      <ul className="space-y-0.5">
        <li>owner@dev.local / DevOwner123!</li>
        <li>admin@dev.local / DevAdmin123!</li>
        <li>manager@dev.local / DevManager123!</li>
        <li>konobar1@dev.local / DevWaiter123!</li>
        <li>kuhinja@dev.local / DevKitchen123!</li>
        <li>sank@dev.local / DevBar123!</li>
      </ul>
    </div>
  );
}
