"use client";

import { useEffect, useState } from "react";
import { getQzSettings, saveQzSettings, type QzPrintSettings } from "../../lib/qz-settings";
import { connectQz, listPrinters, qzTestPrint, isQzLibraryLoaded, QzUnavailableError } from "../../lib/qz-client";

/**
 * P0.16 — podešavanje QZ direktne štampe, PO UREĐAJU (localStorage, vidi
 * qz-settings.ts). Otvara se sa dugmeta u KdsClient.tsx zaglavlju —
 * namerno NIJE admin ekran: kuhinjski radnik (KITCHEN rola, bez
 * settings.manage) mora moći da izabere/testira svoj štampač bez admin
 * prijave, jer je ovo isključivo lokalno svojstvo NJEGOVOG računara, ne
 * poslovno podešavanje restorana.
 */
export function QzSettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<QzPrintSettings>({ enabled: false, printerName: null });
  const [printers, setPrinters] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    setSettings(getQzSettings());
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-white/10 bg-graphite-800 p-5 text-cream-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">QZ direktna štampa</h2>
          <button type="button" onClick={onClose} className="text-cream-300/60 hover:text-cream-100" aria-label="Zatvori">
            ✕
          </button>
        </div>

        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => save({ ...settings, enabled: e.target.checked })}
          />
          Omogući direktnu štampu preko QZ Tray-a (bez Chrome dijaloga)
        </label>

        <div className="mb-4">
          <button
            type="button"
            onClick={refreshPrinters}
            className="min-h-11 rounded-md bg-gold px-4 text-sm font-bold text-white disabled:opacity-40"
            disabled={status === "connecting"}
          >
            {status === "connecting" ? "Povezivanje…" : "Pronađi QZ štampače"}
          </button>
          {status === "connected" && (
            <p className="mt-2 text-xs font-semibold text-success">Povezano — {printers.length} štampač(a) pronađeno.</p>
          )}
          {status === "error" && statusMessage && (
            <p className="mt-2 text-xs text-danger">{statusMessage}</p>
          )}
        </div>

        {printers.length > 0 && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-cream-300/70">Štampač</label>
            <select
              value={settings.printerName ?? ""}
              onChange={(e) => save({ ...settings, printerName: e.target.value || null })}
              className="h-11 w-full rounded-md border border-white/10 bg-graphite-900 px-3 text-sm text-cream-100"
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
              className="min-h-11 w-full rounded-md border border-white/20 py-2 text-sm font-semibold text-cream-100 disabled:opacity-40"
            >
              {testBusy ? "Štampanje…" : "Probna štampa"}
            </button>
            {testResult && <p className="mt-2 text-xs text-cream-300/80">{testResult}</p>}
          </div>
        )}

        <div className="rounded-md border border-white/10 bg-white/[.03] p-3 text-xs text-cream-300/70">
          <p className="mb-1 font-semibold text-cream-300/90">Napomena</p>
          <p>
            Chrome može zatražiti dozvolu &quot;Local Network Access&quot; da bi ovaj sajt mogao da komunicira sa QZ Tray-om
            na localhost-u. Ako konekcija ne uspe, proveri Chrome podešavanja sajta (Site settings → Local Network Access) za{" "}
            <span className="font-mono">tablecore.net</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
