"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/Button";

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
    <div className="flex min-h-screen items-center justify-center bg-graphite px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="mb-8 text-center">
          <p className="font-display text-3xl font-medium text-cream-100">Evropa MM</p>
          <p className="mt-2 text-sm text-cream-300/70">Prijava za osoblje restorana</p>
        </div>

        <form onSubmit={submit} className="rounded-lg bg-white p-6 shadow-elevated">
          {error && (
            <div className="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger animate-fade-in">
              {error}
            </div>
          )}

          <label className="mb-1 block text-xs font-medium text-inkSoft">Email</label>
          <input
            type="email"
            autoComplete="username"
            required
            className="mb-4 w-full rounded-sm border border-line px-3 py-2.5 text-sm focus:border-gold"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label className="mb-1 block text-xs font-medium text-inkSoft">Lozinka</label>
          <div className="relative mb-6">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              className="w-full rounded-sm border border-line px-3 py-2.5 pr-16 text-sm focus:border-gold"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-inkSoft hover:text-ink"
            >
              {showPassword ? "Sakrij" : "Prikaži"}
            </button>
          </div>

          <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
            {loading ? "Prijavljivanje…" : "Prijavi se"}
          </Button>
        </form>

        {process.env.NODE_ENV === "development" && <DevTestAccounts />}
      </div>
    </div>
  );
}

function DevTestAccounts() {
  return (
    <div className="mt-6 rounded-md border border-cream-300/20 bg-white/5 p-4 text-xs text-cream-300/70">
      <p className="mb-2 font-medium text-cream-100">Test nalozi (samo development)</p>
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
