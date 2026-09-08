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

// Bezbedno pozvati više puta — QZ samo prepiše promise fabrike. Poziva se
// TAČNO PRE svakog connect() poziva (ne jednom na učitavanje modula) da
// izbegnemo red-race sa Next.js hot-reload/modul re-evaluacijom u dev modu.
function wireSecurityPromises(): void {
  qz.security.setCertificatePromise((resolve, reject) => {
    fetch("/api/print/qz-certificate")
      .then((res) => res.json())
      .then((body) => resolve(body.certificate ?? ""))
      .catch(() => resolve("")); // vidi cert rutu — prazan sertifikat je bezbedan, QZ tad prikazuje sopstveni "nepouzdano" prompt umesto tihe štampe
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

  wireSecurityPromises();
  // .finally (ne samo .catch) briše connectPromise NA SVAKI ishod, ne samo
  // neuspeh — bez ovoga bi USPEŠNO razrešen promise zauvek ostao keširan
  // ovde, pa bi POZNIJI poziv (npr. posle stvarnog gubitka konekcije van
  // ove funkcije) tiho vratio STARI, već razrešen promise umesto da
  // ponovo proveri qz.websocket.isActive() i pokuša novu konekciju.
  const attempt = qz.websocket
    .connect({ retries: 1, delay: 1 })
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

function buildStandaloneHtml(ticketRoot: HTMLElement): string {
  // Isti kompajlirani stylesheet-ovi kao živa stranica (uklj. print-thermal.css)
  // — QZ Tray na istoj mašini dovlači ove URL-ove preko mreže (javni, isti-
  // origin statički asset, bez potrebe za auth-om), isto poreklo teksta/
  // stilova kao postojeći BrowserPrintTransport (vidi print-transport.ts) —
  // NIKAD duplirana/prekucana CSS kopija.
  const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((link) => `<link rel="stylesheet" href="${link.href}">`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">${stylesheetLinks}</head><body>${ticketRoot.outerHTML}</body></html>`;
}

function measureTicketMm(ticketRoot: HTMLElement): { widthMm: number; heightMm: number } {
  const isW58 = ticketRoot.classList.contains("w58");
  const widthMm = isW58 ? 58 : 80;
  const measureTarget = ticketRoot.querySelector<HTMLElement>(".print-ticket") ?? ticketRoot;
  const contentHeightPx = measureTarget.getBoundingClientRect().height;
  const heightMm = Math.max(MIN_PAGE_HEIGHT_MM, Math.ceil(contentHeightPx * MM_PER_PX) + PAGE_HEIGHT_SAFETY_MM);
  return { widthMm, heightMm };
}

/**
 * Direktna štampa preko QZ-a na imenovani Windows/QZ štampač. Baca
 * (nikad tiho ne guta) na svaki neuspeh — pozivalac (QzPrintTransport)
 * mora videti grešku da NIKAD ne potvrdi uspeh koji se stvarno nije desio
 * (zahtev: "Do not mark a print job successful before QZ reports that the
 * job was accepted for printing").
 */
export async function printTicketViaQz(ticketRoot: HTMLElement, printerName: string): Promise<void> {
  await connectQz();

  const available = await isPrinterAvailable(printerName);
  if (!available) throw new QzPrinterNotFoundError(printerName);

  const { widthMm, heightMm } = measureTicketMm(ticketRoot);
  const html = buildStandaloneHtml(ticketRoot);

  const config = qz.configs.create(printerName, {
    units: "mm",
    size: { width: widthMm, height: heightMm },
    margins: 0,
    // scaleContent: true je namerno konzervativan izbor — QZ rasterizuje
    // HTML u SOPSTVENOM procesu (ne u živoj strani), pa se izmerena visina
    // ovde može sitno razlikovati od QZ-ovog stvarnog renderovanja; scale
    // sprečava da ta razlika odseče sadržaj (gori ishod od blago manjeg
    // teksta). Vidi napomenu u izveštaju — vizuelno proveriti na stvarnom
    // POS-58 i po potrebi podesiti PAGE_HEIGHT_SAFETY_MM.
    scaleContent: true,
  });

  try {
    await qz.print(config, [{ type: "pixel", format: "html", flavor: "plain", data: html }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new QzPrintFailedError(message);
  }
}

/**
 * TEST PRINT (zahtev specifikacije #TEST) — potpuno nezavisno od
 * PrintJob/porudžbine/baze, gradi sopstveni mali HTML string direktno (bez
 * .print-ticket-root u DOM-u), ne kreira NIKAKAV red u bazi.
 */
export async function qzTestPrint(printerName: string, paperWidthMm: 58 | 80): Promise<void> {
  await connectQz();
  const available = await isPrinterAvailable(printerName);
  if (!available) throw new QzPrinterNotFoundError(printerName);

  const now = new Date().toLocaleString("sr-RS");
  const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((link) => `<link rel="stylesheet" href="${link.href}">`)
    .join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8">${stylesheetLinks}</head><body>
    <div class="print-ticket-root${paperWidthMm === 58 ? " w58" : ""}" style="position:static;left:0;">
      <div class="print-ticket">
        <div class="t-header">TABLECORE</div>
        <div class="t-station">QZ TEST</div>
        <div class="t-meta">Štampač: ${printerName}</div>
        <div class="t-meta">${now}</div>
      </div>
    </div>
  </body></html>`;

  const config = qz.configs.create(printerName, {
    units: "mm",
    size: { width: paperWidthMm, height: 40 },
    margins: 0,
    scaleContent: true,
  });

  try {
    await qz.print(config, [{ type: "pixel", format: "html", flavor: "plain", data: html }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new QzPrintFailedError(message);
  }
}
