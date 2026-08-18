/**
 * Faza 6 — apstrakcija štampe (zahtev specifikacije #11). UI/order logika
 * traži print job preko print-service.ts; NIKAD ne zna detalje konkretnog
 * štampača. Imenovanje sledi docs/01-RCS-Plan-v2-MVP.md (PrintingProvider/
 * PrintJobPayload/PrintResult) — taj dokument nikad nije implementiran
 * (koristio je model ProductionTicket koji ne postoji), ali interfejs je
 * koristan i usklađen sa zahtevom #11 (PrintService → BrowserPrintAdapter →
 * budući EscPosAdapter/NetworkPrinterAdapter).
 *
 * MVP: štampa preko browsera je KLIJENTSKA po prirodi (server ne može
 * pozvati window.print()) — server samo kreira PENDING PrintJob i vraća
 * renderovan sadržaj; klijent štampa i potvrđuje rezultat pozivom na
 * confirm endpoint. Registar ispod postoji za BUDUĆE server-side adaptere
 * (ESC/POS LAN, mrežni štampač) koji bi sami zvali printer i menjali status
 * — trenutno je prazan, nijedan server-side provider nije registrovan.
 */

export interface PrintJobPayload {
  printJobId: string;
  restaurantId: string;
  printerType: "BROWSER" | "ESC_POS_LAN" | "NETWORK";
  content: unknown;
}

export interface PrintResult {
  success: boolean;
  errorMessage?: string;
}

export interface PrintingProvider {
  print(job: PrintJobPayload): Promise<PrintResult>;
}

/** Prazan po dizajnu u ovoj fazi — vidi napomenu iznad. */
export const printingProviderRegistry = new Map<"ESC_POS_LAN" | "NETWORK", PrintingProvider>();
