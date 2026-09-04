/**
 * P0.11 — transport granica. Pozivaoci (print-client.ts, KdsClient.tsx,
 * TicketPrintPanel.tsx) zovu ISKLJUČIVO PrintTransport.print(), nikad
 * direktno window.print() — to je jedini uslov da se sutra doda drugi
 * transport (npr. QZ Tray/ESC-POS, vidi PrinterConfig.printerType i
 * packages/domain/printing/types.ts printingProviderRegistry) bez izmene
 * ijednog pozivaoca. BrowserPrintTransport je JEDINA implementacija danas
 * i ostaje podrazumevani/rezervni put čak i pošto se doda lokalni agent.
 *
 * Namerno tanko: print() ne vraća ništa osim da li je window.print() bačen
 * (izuzetak) — da li je korisnik stvarno kliknuo "Štampaj" ili "Otkaži" u
 * browser dijalogu se ne može pouzdano saznati (vidi napomenu u
 * print-client.ts uz printAndConfirm), pa transport to i ne tvrdi.
 */
export interface PrintTransport {
  print(): Promise<void>;
}

export class BrowserPrintTransport implements PrintTransport {
  async print(): Promise<void> {
    window.print();
  }
}

export const defaultPrintTransport: PrintTransport = new BrowserPrintTransport();
