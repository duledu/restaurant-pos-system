/**
 * FISKALIZACIJA — SAMO PRIPREMA ARHITEKTURE. Vidi types.ts za obrazloženje
 * granice/interfejsa. Ovaj fajl dodaje JEDINU stvar koja postoji van
 * čistih tipova: `isFiscalizationEnabled()` (podrazumevano i trenutno
 * ISKLJUČIVO false) i placeholder provajder koji NAMERNO nikad ne uspeva —
 * ni jedno ni drugo se ne poziva iz billing-service.ts ili bilo kog drugog
 * aktivnog toka danas.
 */
import type {
  FiscalizationHealth,
  FiscalizationInvoiceRequest,
  FiscalizationProvider,
  FiscalizationResult,
} from "./types";

export class FiscalizationNotConfiguredError extends Error {
  constructor() {
    super("Fiskalizacija nije konfigurisana — nijedan pravi provajder još nije povezan.");
    this.name = "FiscalizationNotConfiguredError";
  }
}

/**
 * Namerno NE fabrikuje uspešan rezultat — svaki poziv baca grešku umesto da
 * izmišlja broj fakture, PFR brojač, QR kod, verifikacioni URL, žurnal ili
 * fiskalni status. Postoji SAMO da FiscalizationProvider granica ima
 * konkretan (uvek neuspešan) placeholder dok se ne poveže pravi provajder —
 * nijedan pozivalac danas ne postoji (isFiscalizationEnabled() je false).
 */
export class NoopFiscalizationProvider implements FiscalizationProvider {
  async createInvoice(_request: FiscalizationInvoiceRequest): Promise<FiscalizationResult> {
    throw new FiscalizationNotConfiguredError();
  }
  async refundInvoice(_request: FiscalizationInvoiceRequest): Promise<FiscalizationResult> {
    throw new FiscalizationNotConfiguredError();
  }
  async healthCheck(): Promise<FiscalizationHealth> {
    return { reachable: false, detail: "Nijedan fiskalni provajder nije konfigurisan." };
  }
  async getStatus(_requestId: string): Promise<FiscalizationResult> {
    throw new FiscalizationNotConfiguredError();
  }
}

/**
 * fiscalization.enabled — PODRAZUMEVANO FALSE i, danas, JEDINO moguće
 * stanje (nijedan pravi provajder nije povezan). Server-only env
 * promenljiva — NIKAD NEXT_PUBLIC_, isti obrazac kao PIN_ENCRYPTION_KEY
 * (vidi packages/auth/pin-encryption.ts) — fiskalni status/API ključevi ne
 * smeju nikad dospeti u klijentski bundle. Namerno NIJE novi Vercel env
 * unos — odsustvo promenljive VEĆ znači isključeno, ništa se ne mora
 * podesiti nigde da bi trenutno ponašanje (isključeno) važilo. Kad je
 * false (uvek, danas): nema fiskalnih API poziva, nema fiskalnog čekanja,
 * nema fiskalne greške, trenutna naplata i TableCore nefiskalni radni
 * nalog ostaju nepromenjeni.
 */
export function isFiscalizationEnabled(): boolean {
  return process.env.FISCALIZATION_ENABLED === "true";
}

export const fiscalizationProvider: FiscalizationProvider = new NoopFiscalizationProvider();

export type {
  FiscalizationHealth,
  FiscalizationInvoiceRequest,
  FiscalizationLineItem,
  FiscalizationPayment,
  FiscalizationProvider,
  FiscalizationResult,
  FiscalizationResultStatus,
} from "./types";
