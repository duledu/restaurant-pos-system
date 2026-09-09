/**
 * P0.16 — bira koji PrintTransport koristi AUTOMATSKA štampa na KDS-u.
 * Izdvojeno iz KdsClient.tsx da bi bilo testabilno bez React komponente
 * (isti princip kao ready-notifications.ts/menu-search.ts).
 *
 * Pravilo (namerno, vidi izveštaj): ako QZ NIJE dostupan uopšte (biblioteka
 * neučitana ili qz.websocket.connect() ne uspe — QZ Tray ne radi na ovom
 * računaru) automatska štampa se tiho vraća na postojeći BrowserPrintTransport
 * (restoran mora nastaviti da radi). Ako je QZ POVEZAN ali sama štampa na
 * konkretan štampač ne uspe (nije pronađen/offline), NE prelazi tiho na
 * browser — greška se propagira (printAndConfirm je markira kao FAILED,
 * vidljivu/retry-abilnu) da operater primeti stvaran problem sa
 * konfigurisanim štampačem umesto da mu se svaki put neočekivano otvori
 * Chrome dijalog.
 */
import { defaultPrintTransport, QzPrintTransport, type PrintTransport } from "./print-transport";
import { isQzAutoPrintConfigured, type QzPrintSettings } from "./qz-settings";
import { connectQz, isQzLibraryLoaded } from "./qz-client";

export async function resolveAutoPrintTransport(settings: QzPrintSettings, content: unknown): Promise<PrintTransport> {
  if (!isQzAutoPrintConfigured(settings)) return defaultPrintTransport;
  if (!isQzLibraryLoaded()) return defaultPrintTransport;

  try {
    await connectQz();
  } catch {
    return defaultPrintTransport;
  }

  return new QzPrintTransport(settings.printerName as string, content);
}
