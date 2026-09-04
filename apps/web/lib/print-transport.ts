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
 * print-client.ts uz printAndConfirm), pa transport to i ne tvrdi. Ovaj
 * fajl NE tvrdi tihu/neopaženu fizičku štampu — window.print() i dalje
 * zahteva browser dijalog (isti uslov važi i za budući QZ/ESC-POS transport
 * dok se ne poveže stvaran lokalni agent).
 */
export interface PrintTransport {
  print(): Promise<void>;
}

// CSS px -> mm po specifikaciji (96 CSS px = 1in = 25.4mm), NE stvarni DPI
// ekrana/štampača — isti odnos koji @page/mm CSS jedinice već pretpostavljaju.
const MM_PER_PX = 25.4 / 96;
// Bezbednosna rezerva iznad izmerene visine — apsorbuje zaokruživanje
// px->mm konverzije i sitne razlike u renderovanju fonta između ekrana i
// print pipeline-a, tako da sadržaj NIKAD ne prelije na drugi list zbog
// razlike od par desetinki milimetra.
const PAGE_HEIGHT_SAFETY_MM = 3;
const MIN_PAGE_HEIGHT_MM = 20;

/**
 * IZOLOVANI PRINT DOKUMENT (P0.15 — ispravka "prazna prva strana + drugi
 * list papira" bug-a iz produkcije). Ranije je window.print() štampao CEO
 * živi KDS dokument (veliki grid porudžbina), oslanjajući se na
 * `body:has(> .print-ticket-root) > *:not(.print-ticket-root){display:none}`
 * (print-thermal.css) da sakrije sve ostalo. Stvarni (ne headless) Chrome
 * print pipeline za NAMED @page pravilo sa `size: Xmm auto` (print-thermal.css)
 * se pokazao nepouzdan kad u istom dokumentu postoji još sadržaja (čak i
 * sakrivenog) — auto visina ume da otpadne na podrazumevanu veličinu papira
 * (npr. Letter/A4), što daje tiket zbijen u gornji deo ogromne prazne
 * stranice i, zavisno od zaokruživanja, drugi (prazan) list. Headless
 * print-to-PDF (Playwright preferCSSPageSize) NE reprodukuje ovaj bug —
 * koristi drugačiji kod put od stvarnog interaktivnog print dijaloga, zato
 * je Faza 1 headless provera prošla iako je stvarni Chrome print bio pokvaren.
 *
 * Ispravka: kloniraj SAMO .print-ticket-root u potpuno prazan iframe
 * dokument (linkovani isti već-kompajlirani stylesheet-ovi žive stranice —
 * bez duplirane CSS kopije, bez rizika da se razmimoiđu) i, umesto da se
 * osloni na `auto` visinu, IZMERI stvaran render visinu tiketa u JS-u
 * (getBoundingClientRect, tiket je i dalje normalno layout-ovan u živoj
 * strani, samo vizuelno pomeren van ekrana preko left:-9999px) i upiši
 * TAČNU @page visinu za baš ovaj tiket. print-thermal.css/print-report.css
 * ostaju potpuno nepromenjeni — ovo je override SAMO unutar izolovanog
 * iframe dokumenta, za ovaj jedan print poziv.
 */
async function printIsolatedTicket(ticketRoot: HTMLElement): Promise<void> {
  const isW58 = ticketRoot.classList.contains("w58");
  const widthMm = isW58 ? 58 : 80;
  const pageName = isW58 ? "ticket58" : "ticket";

  const measureTarget = ticketRoot.querySelector<HTMLElement>(".print-ticket") ?? ticketRoot;
  const contentHeightPx = measureTarget.getBoundingClientRect().height;
  const heightMm = Math.max(MIN_PAGE_HEIGHT_MM, Math.ceil(contentHeightPx * MM_PER_PX) + PAGE_HEIGHT_SAFETY_MM);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.left = "-9999px";
  iframe.style.top = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  try {
    const iframeDoc = iframe.contentDocument;
    const iframeWindow = iframe.contentWindow;
    if (!iframeDoc || !iframeWindow) {
      throw new Error("Štampa nije podržana u ovom browseru");
    }

    // Isti kompajlirani stylesheet-ovi kao živa stranica (uklj.
    // print-thermal.css) — same-origin apsolutni href-ovi koje je Next.js
    // već ubacio u <head>, klonirani, ne prekucani. Izolovani dokument
    // ispod sadrži ISKLJUČIVO tiket (ništa drugo za sakrivanje), pa
    // "sakrij sve ostalo" pravilo iz print-thermal.css ovde postaje
    // bezopasno neupotrebljeno.
    const stylesheetLinks = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    for (const link of stylesheetLinks) {
      iframeDoc.head.appendChild(link.cloneNode(true));
    }

    const meta = iframeDoc.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    iframeDoc.head.insertBefore(meta, iframeDoc.head.firstChild);

    // Tačna, izmerena visina — NIKAD `auto` u izolovanom dokumentu (vidi
    // napomenu iznad zašto `auto` nije pouzdan u stvarnom print dijalogu).
    const override = iframeDoc.createElement("style");
    override.textContent = `@page ${pageName} { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`;
    iframeDoc.head.appendChild(override);

    iframeDoc.body.appendChild(ticketRoot.cloneNode(true));

    await waitForStylesheets(stylesheetLinks.length, iframeDoc);

    iframeWindow.focus();
    iframeWindow.print();
  } finally {
    // window.print() u realnim browserima blokira dok korisnik ne zatvori
    // dijalog, ali sadržaj je već predat print pipeline-u u trenutku poziva
    // — uklanjanje iframe-a posle kratkog odloga je bezbedno (isti obrazac
    // kao i ostali window.print() pozivaoci u ovoj aplikaciji, koji nikad
    // nisu čekali zatvaranje dijaloga pre nastavka).
    setTimeout(() => iframe.remove(), 1000);
  }
}

function waitForStylesheets(expectedCount: number, doc: Document): Promise<void> {
  if (expectedCount === 0) return Promise.resolve();
  const links = Array.from(doc.querySelectorAll("link[rel=\"stylesheet\"]"));
  return Promise.all(
    links.map(
      (link) =>
        new Promise<void>((resolve) => {
          // Same-origin stylesheet koji je već u browser kešu (upravo je
          // učitan na živoj strani) učitava se skoro trenutno — ovaj
          // timeout je samo bezbednosna granica, ne očekivana putanja, da
          // hipotetički mrežni edge-case nikad ne zamrzne štampu zauvek.
          const done = () => resolve();
          link.addEventListener("load", done, { once: true });
          link.addEventListener("error", done, { once: true });
          setTimeout(done, 500);
        })
    )
  ).then(() => undefined);
}

export class BrowserPrintTransport implements PrintTransport {
  async print(): Promise<void> {
    const ticketRoot = document.querySelector<HTMLElement>(".print-ticket-root");
    if (!ticketRoot) {
      // Pozivalac bez .print-ticket-root u DOM-u (ne bi trebalo da se
      // dogodi za tiket/račun/izveštaj štampu — vidi TicketPrintPanel.tsx)
      // — bezbedan padavinski put, isto ponašanje kao pre ove izmene.
      window.print();
      return;
    }
    await printIsolatedTicket(ticketRoot);
  }
}

export const defaultPrintTransport: PrintTransport = new BrowserPrintTransport();
