// @vitest-environment jsdom
/**
 * Regresija za commit 20a9bc3 ("isolate thermal ticket printing to remove
 * blank/second-page Chrome bug"). Pravi Chromium print dijalog ne poštuje
 * pouzdano `@page { size: Xmm auto }` kad u istom dokumentu postoji još
 * sadržaja (čak i display:none-ovanog) — zato BrowserPrintTransport
 * klonira ISKLJUČIVO .print-ticket-root u izolovan iframe dokument i piše
 * TAČNU (izmerenu) @page visinu, nikad `auto`. Ovaj test ne može da dokaže
 * da stvaran Chrome print dijalog izgleda ispravno (jsdom nema layout/
 * paginaciju) — vidi napomenu na kraju fajla — ali dokazuje da se
 * ARHITEKTURA izolacije ne vraća tiho na "štampaj celu živu stranicu".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPrintTransport } from "../../apps/web/lib/print-transport";

const MM_PER_PX = 25.4 / 96;
const PAGE_HEIGHT_SAFETY_MM = 3;

function rect(height: number): DOMRect {
  return { width: 300, height, top: 0, left: 0, right: 300, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
}

function buildTicketFixture(w58: boolean) {
  document.body.innerHTML = `
    <div id="host-app">
      <div>Simulated live Kitchen page content that must never be printed directly.</div>
    </div>
    <div class="print-ticket-root${w58 ? " w58" : ""}">
      <div class="print-ticket">TICKET CONTENT MARKER — Đorđe Ćosić</div>
    </div>
  `;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/styles/print-thermal.css";
  document.head.appendChild(link);
}

describe("BrowserPrintTransport — isolated print document", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
  });

  it.each([
    { label: "80mm (Kitchen/Bar default)", w58: false, pageName: "ticket", widthMm: 80 },
    { label: "58mm (.w58 variant)", w58: true, pageName: "ticket58", widthMm: 58 },
  ])("clones the ticket into an isolated iframe with an explicit, measured @page size — $label", async ({ w58, pageName, widthMm }) => {
    buildTicketFixture(w58);
    const topPrintSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(500));

    const printPromise = new BrowserPrintTransport().print();

    // The synchronous prefix of print()/printIsolatedTicket() has already
    // run by this point (iframe created+appended, stylesheets cloned,
    // ticket cloned, @page override injected) — the first real suspension
    // point is the stylesheet-load wait, so the iframe is fully built here.
    const iframes = document.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1); // (1) isolated iframe created/used
    const iframe = iframes[0] as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow!;
    const iframeDoc = iframe.contentDocument!;
    vi.spyOn(iframeWindow, "focus").mockImplementation(() => {}); // jsdom stub is "not implemented" — silence it
    const iframePrintSpy = vi.spyOn(iframeWindow, "print").mockImplementation(() => {});

    // (2) ticket node cloned into the isolated document, and (3) the live
    // host page content is NOT present there — nothing else to print.
    const clonedTicket = iframeDoc.querySelector(".print-ticket-root");
    expect(clonedTicket?.textContent).toContain("TICKET CONTENT MARKER — Đorđe Ćosić");
    expect(iframeDoc.body.textContent).not.toContain("Simulated live Kitchen page");

    // (4) required stylesheet propagated into the isolated document.
    const clonedLink = iframeDoc.querySelector('link[rel="stylesheet"]') as HTMLLinkElement | null;
    expect(clonedLink?.getAttribute("href")).toBe("/styles/print-thermal.css");

    // (5)/(6) explicit @page size derived from the MEASURED ticket height —
    // never `auto`. The expected number uses the exact same px->mm formula
    // as print-transport.ts, proving the measured value actually flows
    // into the injected rule (not just "some number is present").
    const expectedHeightMm = Math.ceil(500 * MM_PER_PX) + PAGE_HEIGHT_SAFETY_MM;
    const overrideStyle = Array.from(iframeDoc.querySelectorAll("style")).find((s) =>
      s.textContent?.includes(`@page ${pageName}`)
    );
    expect(overrideStyle?.textContent).toContain(`size: ${widthMm}mm ${expectedHeightMm}mm`);
    expect(overrideStyle?.textContent).not.toMatch(/size:\s*\d+mm\s+auto/);

    await vi.advanceTimersByTimeAsync(600); // past the stylesheet-load wait
    await printPromise;

    // (7) print() fires on the ISOLATED iframe's window, never the top-level one.
    expect(iframePrintSpy).toHaveBeenCalledTimes(1);
    expect(topPrintSpy).not.toHaveBeenCalled();
  });

  it("cleans up the temporary iframe after printing (8)", async () => {
    buildTicketFixture(false);
    vi.spyOn(window, "print").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(200));

    const printPromise = new BrowserPrintTransport().print();
    const iframe = document.querySelector("iframe")!;
    vi.spyOn(iframe.contentWindow!, "focus").mockImplementation(() => {});
    vi.spyOn(iframe.contentWindow!, "print").mockImplementation(() => {});

    await vi.advanceTimersByTimeAsync(600); // resolves the stylesheet wait, print() proceeds
    await printPromise;
    expect(document.querySelectorAll("iframe")).toHaveLength(1); // not yet — cleanup is deliberately deferred

    await vi.advanceTimersByTimeAsync(1100); // past the 1000ms cleanup delay
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("falls back to window.print() when there is no .print-ticket-root (non-ticket callers untouched)", async () => {
    document.body.innerHTML = "<div>no ticket on this screen</div>";
    const topPrintSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    await new BrowserPrintTransport().print();

    expect(topPrintSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});

/**
 * OGRANIČENJE (namerno, vidi zahtev zadatka): jsdom nema pravi layout/CSS
 * paginaciju, pa ovaj fajl NE MOŽE dokazati da stvaran Chrome print
 * dijalog renderuje tačno jednu stranicu tačne veličine — to je posebno
 * (ručno, Playwright-om vođeno) provereno pri commit-u 20a9bc3 i nije
 * automatizovano ovde da bi se izbeglo uvođenje teške nove zavisnosti
 * (Playwright + browser binarni) u standardni test paket.
 */
