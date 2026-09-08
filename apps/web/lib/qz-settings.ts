/**
 * Podešavanje QZ direktne štampe — NAMERNO lokalno (localStorage), ne
 * PrinterConfig (restoran/lokacija-nivo, vidi settings-service.ts). Ime
 * Windows štampača je fizičko svojstvo KONKRETNOG kuhinjskog računara/
 * browsera, ne restorana — dva kuhinjska računara na istoj lokaciji mogu
 * imati različite QZ štampače prikačene. PrinterConfig i dalje ostaje
 * jedini izvor istine za paperWidthMm/isEnabled snapshot ugrađen u sam
 * PrintJob.content (nepromenjeno ovom izmenom).
 */

const STORAGE_KEY = "tablecore.qzPrintSettings";

export interface QzPrintSettings {
  enabled: boolean;
  printerName: string | null;
}

const DEFAULT_SETTINGS: QzPrintSettings = { enabled: false, printerName: null };

export function getQzSettings(): QzPrintSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed?.enabled),
      printerName: typeof parsed?.printerName === "string" ? parsed.printerName : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveQzSettings(settings: QzPrintSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage nedostupan (privatni režim i sl.) — podešavanje važi
    // samo za trenutnu sesiju, bez greške operateru.
  }
}

/** Da li je QZ direktna štampa spremna za AUTOMATSKU upotrebu na ovom
 * uređaju — omogućena I izabran je štampač. Sama dostupnost/konekcija se
 * proverava tek pri pokušaju štampe (vidi qz-client.ts). */
export function isQzAutoPrintConfigured(settings: QzPrintSettings): boolean {
  return settings.enabled && Boolean(settings.printerName);
}
