"use client";

import { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { getQzSettings, saveQzSettings, type QzPrintSettings } from "../../lib/qz-settings";
import { connectQz, listPrinters, qzTestPrint, isQzLibraryLoaded, getQzSigningStatus, QzUnavailableError } from "../../lib/qz-client";

/**
 * P0.16 / P0.17 — podešavanje QZ direktne štampe, PO UREĐAJU (localStorage,
 * vidi qz-settings.ts). NAMERNO admin-only ekran (montira se ISKLJUČIVO iz
 * printers-settings-client.tsx, iza (admin) layout-a koji već zahteva
 * ADMIN_ROLES — vidi apps/web/app/(admin)/layout.tsx) — postavljanje
 * fizičkog Windows štampača na kuhinjskom računaru je administratorski
 * zadatak, ne kuhinjski. KDS (KdsClient.tsx) posle ovoga samo ČITA već
 * sačuvano podešavanje (getQzSettings), bez ijedne kontrole za izbor/
 * omogućavanje/testiranje.
 *
 * Ostaje inline kartica (ne modal) da bi vizuelno pratila ostatak ove
 * admin stranice (Kuhinja/Šank/Račun kartice iznad).
 */
export function QzSettingsPanel() {
  const [settings, setSettings] = useState<QzPrintSettings>({ enabled: false, printerName: null });
  const [printers, setPrinters] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [signingConfigured, setSigningConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    setSettings(getQzSettings());
    // P0.20 — status potpisivanja se čita NEZAVISNO od "Pronađi QZ štampače"
    // (ne zahteva aktivnu QZ konekciju) da admin vidi stanje i kad QZ Tray
    // uopšte nije pokrenut na ovom računaru. Samo boolean sa servera —
    // nikad sertifikat/ključ (vidi getQzSigningStatus u qz-client.ts).
    getQzSigningStatus()
      .then((res) => setSigningConfigured(res.signingConfigured))
      .catch(() => setSigningConfigured(false));
  }, []);

  async function refreshPrinters() {
    setStatus("connecting");
    setStatusMessage(null);
    if (!isQzLibraryLoaded()) {
      setStatus("error");
      setStatusMessage("QZ biblioteka nije učitana u browseru.");
      return;
    }
    try {
      await connectQz();
      const found = await listPrinters();
      setPrinters(found);
      setStatus("connected");
    } catch (e) {
      setStatus("error");
      setStatusMessage(
        e instanceof QzUnavailableError
          ? `QZ Tray nije dostupan: ${e.message}. Proveri da li je QZ Tray pokrenut na ovom računaru, i da li je Chrome dozvolio "Local Network Access" za ovaj sajt.`
          : e instanceof Error
            ? e.message
            : "Nepoznata greška"
      );
    }
  }

  function save(next: QzPrintSettings) {
    setSettings(next);
    saveQzSettings(next);
  }

  async function runTestPrint() {
    if (!settings.printerName || testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      await qzTestPrint(settings.printerName, 58);
      setTestResult("Probna štampa poslata.");
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : "Greška pri probnoj štampi");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3">
        <h2 className="font-semibold text-ink">QZ direktna štampa — ovaj računar</h2>
        <p className="mt-0.5 text-xs text-inkSoft">
          Vezano za FIZIČKI računar/browser na kome se ovo sačuva (npr. kuhinjski računar), ne za restoran u celini.
          Konobar/kuhinja ne vide ovo podešavanje — samo status.
        </p>
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => save({ ...settings, enabled: e.target.checked })}
        />
        Omogući direktnu štampu preko QZ Tray-a na ovom računaru (bez Chrome dijaloga)
      </label>

      <div className="mb-4">
        <button
          type="button"
          onClick={refreshPrinters}
          className="min-h-11 rounded-md bg-graphite px-4 text-sm font-semibold text-cream-100 disabled:opacity-40"
          disabled={status === "connecting"}
        >
          {status === "connecting" ? "Povezivanje…" : "Pronađi QZ štampače"}
        </button>
        {status === "connected" && (
          <p className="mt-2 text-xs font-semibold text-success">Povezano — {printers.length} štampač(a) pronađeno.</p>
        )}
        {status === "error" && statusMessage && <p className="mt-2 text-xs text-danger">{statusMessage}</p>}
      </div>

      {printers.length > 0 && (
        <div className="mb-4">
          <label className="mb-1.5 block text-xs text-inkSoft">Štampač</label>
          <select
            value={settings.printerName ?? ""}
            onChange={(e) => save({ ...settings, printerName: e.target.value || null })}
            className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
          >
            <option value="">— izaberi —</option>
            {printers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      )}

      {settings.printerName && (
        <div className="mb-4">
          <button
            type="button"
            onClick={runTestPrint}
            disabled={testBusy}
            className="min-h-11 rounded-md border border-line px-5 py-2 text-sm font-semibold text-inkSoft hover:border-gold/50 hover:text-ink disabled:opacity-40"
          >
            {testBusy ? "Štampanje…" : "Probna štampa (QZ)"}
          </button>
          {testResult && <p className="mt-2 text-xs text-inkSoft">{testResult}</p>}
        </div>
      )}

      <div className="mb-4 rounded-md border border-line p-3 text-xs">
        <p className="mb-2 font-semibold text-ink">Status poverenja QZ Tray-a</p>
        <dl className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-inkSoft">Konekcija</dt>
            <dd className="font-medium text-ink">
              {status === "connected" ? "Povezano" : status === "connecting" ? "Povezivanje…" : status === "error" ? "Greška" : "Nepoznato (klikni „Pronađi QZ štampače“)"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-inkSoft">Lokalni štampač</dt>
            <dd className="font-medium text-ink">{settings.printerName ?? "Nije izabran"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-inkSoft">Potpisivanje</dt>
            <dd className={`font-medium ${signingConfigured ? "text-success" : "text-inkSoft"}`}>
              {signingConfigured === null ? "Proveravam…" : signingConfigured ? "Pouzdano / tiha štampa spremna" : "Nepotpisano / potrebna potvrda"}
            </dd>
          </div>
        </dl>
        {signingConfigured === false && (
          <p className="mt-2 border-t border-line pt-2 text-inkSoft">
            Bez podešenog potpisivanja, QZ Tray će na SVAKOJ konekciji/štampi prikazati sopstveni prozor
            &quot;Allow?&quot; koji neko na kuhinjskom računaru mora ručno potvrditi. Ovo je normalno i bezbedno
            ponašanje QZ Tray-a bez sertifikata — ne pokušavamo da ga zaobiđemo. Za tihu štampu bez tog prozora,
            administrator sistema treba da postavi <code className="rounded bg-cream-100 px-1">QZ_CERTIFICATE</code> i{" "}
            <code className="rounded bg-cream-100 px-1">QZ_PRIVATE_KEY</code> kao server-side environment promenljive
            (Vercel), koristeći QZ Tray sertifikat za potpisivanje (jedan sertifikat važi za sve restorane/računare —
            preporučena opcija za TableCore). Privatni ključ se NIKAD ne unosi ovde niti se čuva u bazi/browseru —
            ovaj ekran samo čita da li je već podešen na serveru.
          </p>
        )}
      </div>

      <div className="rounded-md border border-line bg-cream-100 p-3 text-xs text-inkSoft">
        <p className="mb-1 font-semibold text-ink">Napomena</p>
        <p>
          Chrome može zatražiti dozvolu &quot;Local Network Access&quot; da bi ovaj sajt mogao da komunicira sa QZ Tray-om
          na localhost-u. Ako konekcija ne uspe, proveri Chrome podešavanja sajta (Site settings → Local Network Access)
          za ovaj domen — na RAČUNARU na kome se štampa (npr. kuhinjski računar), ne na uređaju administratora ako se
          razlikuju.
        </p>
      </div>
    </Card>
  );
}
