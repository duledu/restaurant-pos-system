"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../../components/ui/Card";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { useInstallPrompt } from "../../../../components/system/InstallAppButton";

interface RestaurantSettings {
  address: string | null;
  phone: string | null;
  taxIdNumber: string | null;
  receiptFooterText: string | null;
  receiptLegalNote: string | null;
  logoUrl: string | null;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const FIELDS: { key: keyof RestaurantSettings; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: "address", label: "Adresa", placeholder: "Ulica i broj, grad" },
  { key: "phone", label: "Telefon", placeholder: "+381 ..." },
  { key: "taxIdNumber", label: "PIB", placeholder: "123456789" },
  { key: "receiptFooterText", label: "Tekst na dnu računa", placeholder: "Hvala na poseti!" },
  { key: "receiptLegalNote", label: "Napomena o statusu računa", placeholder: "Radni nalog – nije fiskalni račun" },
];

export function RestaurantSettingsClient() {
  const { canInstall, promptInstall } = useInstallPrompt();
  const [values, setValues] = useState<RestaurantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/settings/restaurant");
      setValues(res.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju podešavanja");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!values || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/restaurant", { method: "PUT", body: JSON.stringify(values) });
      setValues(res.settings);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri čuvanju");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Podešavanja restorana</h1>
        <p className="mt-1 text-sm text-inkSoft">
          Podaci koji se prikazuju na kupčevom računu (adresa, telefon, PIB, tekst na dnu računa)
        </p>
      </div>

      {error && <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}
      {saved && <div className="mb-4 rounded-md bg-success-soft px-4 py-3 text-sm text-success">Sačuvano.</div>}

      <Card className="p-5">
        {loading || !values ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="mb-1.5 block text-sm font-medium text-inkSoft">{f.label}</label>
                <input
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value || null })}
                  className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="mt-2 min-h-11 rounded-md bg-graphite px-5 py-2.5 text-sm font-semibold text-cream-100 disabled:opacity-40"
            >
              {saving ? "Čuvanje…" : "Sačuvaj"}
            </button>
          </div>
        )}
      </Card>

      {canInstall && (
        <Card className="mt-6 p-5">
          <h2 className="text-sm font-semibold text-ink">Aplikacija</h2>
          <p className="mt-1 text-sm text-inkSoft">
            Instalirajte TableCore kao aplikaciju na ovom uređaju za brži pristup i prikaz preko celog ekrana.
          </p>
          <button
            type="button"
            onClick={promptInstall}
            className="mt-3 inline-flex min-h-11 items-center rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-gold/50"
          >
            Instaliraj TableCore aplikaciju
          </button>
        </Card>
      )}
    </div>
  );
}
