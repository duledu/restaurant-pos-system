/**
 * P0.16 — centralizovan omotač oko zvanične `qz-tray` JS biblioteke.
 * JEDINO mesto u kodu koje sme da uvozi `qz-tray` ili poziva `qz.websocket`/
 * `qz.print`/... direktno — pozivaoci (QzPrintTransport u print-transport.ts,
 * QzSettingsPanel.tsx) zovu ISKLJUČIVO funkcije odavde.
 *
 * ARHITEKTURA: QZ Tray živi na localhost kod KUHINJSKOG računara/browsera —
 * konobarov telefon NIKAD ne treba QZ (šalje porudžbinu na server kao i do
 * sada; server pravi PrintJob; KDS EKRAN na kuhinjskom računaru je taj koji
 * lokalno štampa preko QZ-a). Ovaj fajl se zato nikad ne uvozi van KDS-
 * specifičnog koda.
 *
 * FORMAT: pixel/html (QZ renderuje HTML preko sopstvenog rasterizera i šalje
 * kao sliku), NAMERNO ne raw ESC/POS. Generički POS-58 klonovi imaju
 * nepouzdanu/nepotpunu tabelu kodne strane za srpska slova (č/ć/š/đ/ž) preko
 * raw ESC/POS komandi — pixel/html put koristi font renderovanje browsera
 * (isti font koji već ispravno prikazuje ćirilicu/latinicu na ekranu i u
 * postojećem browser print-u), pa je tačnost teksta garantovana bez obzira
 * na firmware konkretnog jeftinog štampača (zahtev specifikacije: "Do not
 * sacrifice text correctness just to force raw ESC/POS").
 */
import * as qz from "qz-tray";
import { buildKitchenBarTicketHtml, buildTestPrintHtml, type QzKitchenBarTicketData } from "./qz-ticket-html";

export class QzUnavailableError extends Error {
  constructor(message = "QZ Tray nije dostupan") {
    super(message);
    this.name = "QzUnavailableError";
  }
}
export class QzPrinterNotFoundError extends Error {
  constructor(printerName: string) {
    super(`Štampač "${printerName}" nije pronađen u QZ Tray-u`);
    this.name = "QzPrinterNotFoundError";
  }
}
export class QzPrintFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QzPrintFailedError";
  }
}

/** Bez biblioteke učitane u browseru, QZ je strukturno nedostupan — provera
 * pre bilo kog pokušaja konekcije. */
export function isQzLibraryLoaded(): boolean {
  return typeof qz !== "undefined" && Boolean(qz?.websocket);
}

interface QzCertificateResponse {
  certificate: string;
  signingConfigured: boolean;
}

/**
 * Admin-only status čitanje (QzSettingsPanel.tsx "poverenje/trust" sekcija).
 * NAMERNO vraća SAMO boolean, nikad sam sertifikat/ključ — Admin ekran sme
 * da PRIKAŽE da li je potpisivanje podešeno, ne da vidi/preuzme kredencijale
 * (zahtev: "do NOT expose QZ_PRIVATE_KEY... or allow it to be viewed from
 * Admin"). Odvojeno od wireSecurityPromises() da Admin može proveriti status
 * BEZ da pokrene stvarnu QZ konekciju (npr. i kad QZ Tray uopšte nije
 * pokrenut na ovom računaru).
 */
export async function getQzSigningStatus(): Promise<{ signingConfigured: boolean }> {
  const { signingConfigured } = await fetchCertificateStatus();
  return { signingConfigured };
}

async function fetchCertificateStatus(): Promise<QzCertificateResponse> {
  try {
    const res = await fetch("/api/print/qz-certificate");
    const body = await res.json();
    return { certificate: typeof body?.certificate === "string" ? body.certificate : "", signingConfigured: Boolean(body?.signingConfigured) };
  } catch {
    return { certificate: "", signingConfigured: false };
  }
}

/**
 * P0.18 — ISPRAVKA "Failed to sign request": security promise-ovi se
 * registruju kod QZ-a SAMO kad je potpisivanje STVARNO podešeno na
 * serveru (signingConfigured, provereno PRE registracije, ne posle).
 *
 * Zašto ovo mora biti uslovno, ne uvek: QZ Tray ima DVA potpuno različita
 * unutrašnja toka — (1) NIJEDAN signature promise nije registrovan -> QZ
 * sam pada na sopstveni podrazumevani nepotpisan tok (prikazuje sopstveni
 * "dozvoli jednom?" prompt), TAČNO ono što zvaničan QZ demo sajt radi i
 * što je već potvrđeno da radi na ovom hardveru; (2) signature promise JESTE
 * registrovan -> QZ ga zove za svaki potpisiv zahtev i OČEKUJE stvaran
 * potpis. Kad QZ_PRIVATE_KEY nije podešen, qz-sign ruta i dalje bezbedno
 * vraća prazan string (nikad grešku) — ali PRAZAN potpis u grani (2) QZ
 * Tray tumači kao NEUSPEO pokušaj potpisivanja ("Failed to sign request"),
 * ne kao "nema potpisivanja". Rešenje nije popraviti šta se vraća, nego
 * NIKAD ne ući u granu (2) dok stvarni ključ ne postoji.
 *
 * Bezbedno pozvati više puta — QZ samo prepiše promise fabrike. Poziva se
 * TAČNO PRE svakog connect() poziva (ne jednom na učitavanje modula) da
 * izbegnemo red-race sa Next.js hot-reload/modul re-evaluacijom u dev modu.
 */
async function wireSecurityPromises(): Promise<void> {
  const { certificate, signingConfigured } = await fetchCertificateStatus();
  if (!signingConfigured) return; // NIŠTA se ne registruje — QZ ostaje u sopstvenom podrazumevanom nepotpisanom toku

  qz.security.setCertificatePromise((resolve) => {
    resolve(certificate);
  });
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((toSign: string) => {
    return fetch("/api/print/qz-sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toSign }),
    })
      .then((res) => res.json())
      .then((body) => body.signature ?? "");
  });
}

// Namerno BEZ memoizacije klijenta na nivou modula (isti princip kao
// packages/domain/cache/cache-client.ts) — SAMO jedan in-flight connect
// promise se deli da se izbegnu paralelne WebSocket konekcije (zahtev:
// "avoid multiple simultaneous websocket connections"), ali svaki NOV poziv
// posle uspeha/neuspeha ponovo proverava stvarno stanje (qz.websocket.isActive()),
// ne keširanu pretpostavku.
let connectPromise: Promise<void> | null = null;

/** Poveži se na QZ Tray ako već nismo povezani. Baca QzUnavailableError sa
 * jasnom porukom ako biblioteka nije učitana ili konekcija ne uspe (QZ Tray
 * ne radi, Local Network Access blokiran, itd.) — pozivalac odlučuje da li
 * da tiho pređe na browser fallback ili prikaže grešku. */
export async function connectQz(): Promise<void> {
  if (!isQzLibraryLoaded()) {
    throw new QzUnavailableError("QZ biblioteka nije učitana u browseru");
  }
  if (qz.websocket.isActive()) return;
  if (connectPromise) return connectPromise;

  // .finally (ne samo .catch) briše connectPromise NA SVAKI ishod, ne samo
  // neuspeh — bez ovoga bi USPEŠNO razrešen promise zauvek ostao keširan
  // ovde, pa bi POZNIJI poziv (npr. posle stvarnog gubitka konekcije van
  // ove funkcije) tiho vratio STARI, već razrešen promise umesto da
  // ponovo proveri qz.websocket.isActive() i pokuša novu konekciju.
  // wireSecurityPromises() MORA biti završen (uklj. provera signingConfigured)
  // PRE websocket.connect() poziva — otud .then lanac, ne odvojen await.
  const attempt = wireSecurityPromises()
    .then(() => qz.websocket.connect({ retries: 1, delay: 1 }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new QzUnavailableError(`QZ Tray konekcija nije uspela: ${message}`);
    })
    .finally(() => {
      connectPromise = null;
    });
  connectPromise = attempt;
  return attempt;
}

export async function listPrinters(): Promise<string[]> {
  await connectQz();
  const result = await qz.printers.find();
  return Array.isArray(result) ? result : [result];
}

export async function isPrinterAvailable(printerName: string): Promise<boolean> {
  const printers = await listPrinters();
  return printers.includes(printerName);
}

const MM_PER_PX = 25.4 / 96; // isti odnos kao print-transport.ts — CSS px specifikacija, ne ekranski DPI
const PAGE_HEIGHT_SAFETY_MM = 5; // malo velikodušnija rezerva nego browser put — QZ rasterizuje u SOPSTVENOM procesu, ne u živoj strani, pa scaleContent (ispod) apsorbuje sitnu razliku bez rizika da odseče sadržaj
const MIN_PAGE_HEIGHT_MM = 20;
// Dovoljno širok/visok da NIKAD sam ne ograniči layout ni za 80mm ni za
// najduži realan tiket — STVARNA širina tiketa dolazi iz CSS-a UNUTAR
// samog dokumenta (html,body{width:${widthMm}mm}, vidi qz-ticket-html.ts),
// ne iz dimenzija ovog merenog iframe-a.
const MEASURE_IFRAME_WIDTH_PX = 320;
const MEASURE_IFRAME_HEIGHT_PX = 3000;

/**
 * Meri STVARNU renderovanu visinu dokumenta (isti dvoprolazni princip kao
 * print-transport.ts: prvi prolaz bez visine/`auto`, izmeri, drugi prolaz
 * sa TAČNOM visinom) — NIKAD se ne oslanja isključivo na `auto` čak ni za
 * QZ-ov rasterizer, iz istog razloga koji je već jednom potvrđen za stvaran
 * interaktivan Chrome print dijalog (vidi print-transport.ts P0.15).
 */
async function measureDocumentHeightMm(html: string): Promise<number> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.left = "-9999px";
  iframe.style.top = "0";
  iframe.style.width = `${MEASURE_IFRAME_WIDTH_PX}px`;
  iframe.style.height = `${MEASURE_IFRAME_HEIGHT_PX}px`;
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    if (!doc) return MIN_PAGE_HEIGHT_MM;
    doc.open();
    doc.write(html);
    doc.close();
    const contentHeightPx = doc.body.getBoundingClientRect().height;
    return Math.max(MIN_PAGE_HEIGHT_MM, Math.ceil(contentHeightPx * MM_PER_PX) + PAGE_HEIGHT_SAFETY_MM);
  } finally {
    iframe.remove();
  }
}

async function printHtmlViaQz(printerName: string, widthMm: number, buildHtml: (heightMm?: number) => string): Promise<void> {
  await connectQz();

  const available = await isPrinterAvailable(printerName);
  if (!available) throw new QzPrinterNotFoundError(printerName);

  const draftHtml = buildHtml(undefined); // "auto" prolaz, samo za merenje
  const heightMm = await measureDocumentHeightMm(draftHtml);
  const finalHtml = buildHtml(heightMm); // konačan prolaz sa TAČNOM izmerenom visinom

  const config = qz.configs.create(printerName, {
    units: "mm",
    size: { width: widthMm, height: heightMm },
    margins: 0,
    // scaleContent: true je namerno konzervativan izbor — QZ rasterizuje
    // HTML u SOPSTVENOM procesu (ne u živoj strani), pa se izmerena visina
    // ovde može sitno razlikovati od QZ-ovog stvarnog renderovanja; scale
    // sprečava da ta razlika odseče sadržaj (gori ishod od blago manjeg
    // teksta). Vizuelno proveriti na stvarnom POS-58.
    scaleContent: true,
  });

  try {
    await qz.print(config, [{ type: "pixel", format: "html", flavor: "plain", data: finalHtml }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new QzPrintFailedError(message);
  }
}

/**
 * Direktna štampa preko QZ-a na imenovani Windows/QZ štampač. Baca
 * (nikad tiho ne guta) na svaki neuspeh — pozivalac (QzPrintTransport)
 * mora videti grešku da NIKAD ne potvrdi uspeh koji se stvarno nije desio
 * (zahtev: "Do not mark a print job successful before QZ reports that the
 * job was accepted for printing").
 *
 * P0.19 — prima STRUKTURIRAN sadržaj (isti oblik kao PrintJob.content za
 * KITCHEN/BAR tiket, uklj. već-zamrznut paperWidthMm), NE DOM element.
 * Namerno napušteno kloniranje `.print-ticket-root`/app stylesheet-ova —
 * to je bio uzrok lošeg 58mm renderovanja (vidi qz-ticket-html.ts).
 */
export async function printTicketViaQz(data: QzKitchenBarTicketData, printerName: string): Promise<void> {
  await printHtmlViaQz(printerName, data.paperWidthMm, (heightMm) => buildKitchenBarTicketHtml(data, heightMm));
}

/**
 * TEST PRINT (zahtev specifikacije #TEST) — potpuno nezavisno od
 * PrintJob/porudžbine/baze, gradi sopstveni mali HTML dokument (isti
 * namenski template kao printTicketViaQz), ne kreira NIKAKAV red u bazi.
 */
export async function qzTestPrint(printerName: string, paperWidthMm: 58 | 80): Promise<void> {
  await printHtmlViaQz(printerName, paperWidthMm, (heightMm) => buildTestPrintHtml(printerName, paperWidthMm, heightMm));
}
