/**
 * P0.19 — namenski, samostalan HTML dokument za QZ termalnu štampu.
 * NIKAD ne kloniraj app-ove stylesheet-ove/`.print-ticket-root` ovde (vidi
 * napomena u qz-client.ts zašto je to bio uzrok lošeg 58mm renderovanja) —
 * `.print-ticket-root` nosi `position:fixed;left:-9999px` kao SVOJE
 * OSNOVNO (ekransko) pravilo u print-thermal.css, sa ispravkom UNUTAR
 * `@media print` — QZ-ov sopstveni HTML rasterizer ne mora (i po
 * ponašanju uočenom na stvarnom hardveru, izgleda da ne) primenjuje
 * `@media print` pravila, pa je klonirani tiket ostajao pomeren van
 * stranice, a QZ je efektivno štampao skoro-praznu, loše-dimenzionisanu
 * stranicu. Ovaj fajl gradi POTPUNO nezavisan dokument — sopstveni,
 * eksplicitan, in-line CSS, ISTE tipografske vrednosti kao print-thermal.css
 * (da vizuelni identitet ostane isti, bez redizajna hijerarhije podataka),
 * bez ijedne spoljne zavisnosti koja bi mogla da unese ekranske stilove.
 *
 * Širina STRANICE (papir) ostaje nominalna (58mm/80mm — štampač mora znati
 * stvaran papir), ali SADRŽAJ dobija unutrašnji padding (iste vrednosti
 * koje print-thermal.css već koristi za 58mm/80mm) — "conservative content
 * width", ne pretpostavka da je cela fizička širina štampljiva.
 */

export interface QzTicketItem {
  quantity: number;
  name: string;
  note?: string | null;
  modifiers?: string[];
}

export interface QzKitchenBarTicketData {
  stationLabel: string;
  tableLabel: string;
  orderNumber: string;
  waiterName: string;
  submittedAt: string; // ISO
  isAdditional: boolean;
  items: QzTicketItem[];
  /** Iz PrintJob.content — već zamrznut snapshot PrinterConfig.paperWidthMm
   * u trenutku dispatch-a (isti izvor kao browser transport), NIKAD
   * hardkodovano ovde — Kuhinja/Šank/Račun mogu imati različite širine. */
  paperWidthMm: number;
}

interface TicketTypography {
  headerPx: number;
  stationPx: number;
  tablePx: number;
  metaPx: number;
  additionalPx: number;
  itemPx: number;
  notePx: number;
  footerPx: number;
  qtyWidthMm: number;
  noteIndentMm: number;
  paddingMm: [number, number]; // [vertical, horizontal] — isto kao print-thermal.css .print-ticket padding
}

// Vrednosti IDENTIČNE apps/web/styles/print-thermal.css (.print-ticket / .w58
// varijante) — namerno, da se vizuelni identitet tiketa ne menja, samo
// mehanizam renderovanja (in-line, ne kloniran spoljni stylesheet).
const TYPOGRAPHY_80: TicketTypography = {
  headerPx: 18,
  stationPx: 22,
  tablePx: 30,
  metaPx: 15,
  additionalPx: 16,
  itemPx: 19,
  notePx: 13,
  footerPx: 13,
  qtyWidthMm: 11,
  noteIndentMm: 13.5,
  paddingMm: [3, 4],
};
const TYPOGRAPHY_58: TicketTypography = {
  headerPx: 15,
  stationPx: 17,
  tablePx: 22,
  metaPx: 12,
  additionalPx: 13,
  itemPx: 15,
  notePx: 11,
  footerPx: 10,
  qtyWidthMm: 8,
  noteIndentMm: 10,
  paddingMm: [2, 2.5],
};

function typographyFor(widthMm: number): TicketTypography {
  return widthMm <= 58 ? TYPOGRAPHY_58 : TYPOGRAPHY_80;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Zajednička "koverta" dokumenta — @page je NAMERNO bezimena (ovaj dokument
 * NIKAD ne deli stranicu ni sa čim drugim, nema potrebe za imenovanim
 * @page kolizijskim mehanizmom kao print-thermal.css). `heightMm`
 * izostavljen -> `auto` (koristi se za PRVI, merni prolaz — vidi qz-client.ts);
 * prosleđen -> tačna izmerena visina (isti princip kao browser transport,
 * NIKAD se ne oslanja isključivo na `auto` za finalni ispis).
 */
function renderDocument(params: { widthMm: number; heightMm?: number; bodyHtml: string }): string {
  const { widthMm, heightMm, bodyHtml } = params;
  const pageSize = heightMm ? `${widthMm}mm ${heightMm}mm` : `${widthMm}mm auto`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: ${pageSize}; margin: 0; }
  html, body { margin: 0; padding: 0; width: ${widthMm}mm; background: #fff; }
  body { font-family: "Courier New", Consolas, monospace; color: #000; line-height: 1.3; box-sizing: border-box; }
  * { box-sizing: border-box; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

export function buildKitchenBarTicketHtml(data: QzKitchenBarTicketData, heightMm?: number): string {
  const t = typographyFor(data.paperWidthMm);
  const time = formatTime(data.submittedAt);

  const itemsHtml = data.items
    .map((item) => {
      const modifiersHtml = (item.modifiers ?? [])
        .map((m) => `<div style="font-size:${t.notePx}px;font-style:italic;font-weight:700;padding-left:${t.noteIndentMm}mm;margin:.5mm 0 1mm;">${escapeHtml(m)}</div>`)
        .join("");
      const noteHtml = item.note
        ? `<div style="font-size:${t.notePx}px;font-style:italic;padding-left:${t.noteIndentMm}mm;margin:.5mm 0 1mm;">* ${escapeHtml(item.note)}</div>`
        : "";
      return `<div style="border-top:1px dotted #000;padding-top:1.5mm;margin-top:1.5mm;">
        <div style="display:flex;align-items:flex-start;gap:2.5mm;font-weight:700;font-size:${t.itemPx}px;">
          <span style="min-width:${t.qtyWidthMm}mm;">${item.quantity}x</span>
          <span style="flex:1;">${escapeHtml(item.name)}</span>
        </div>
        ${modifiersHtml}${noteHtml}
      </div>`;
    })
    .join("");

  const additionalHtml = data.isAdditional
    ? `<div style="font-weight:700;font-size:${t.additionalPx}px;letter-spacing:.03em;text-align:center;background:#000;color:#fff;padding:1.5mm 0;margin:2mm 0;">DODATNA PORUDŽBINA</div>`
    : "";

  const [padV, padH] = t.paddingMm;
  const bodyHtml = `<div style="width:${data.paperWidthMm}mm;padding:${padV}mm ${padH}mm;">
    <div style="font-weight:700;font-size:${t.headerPx}px;letter-spacing:.06em;text-align:center;">TABLECORE</div>
    <div style="font-weight:700;font-size:${t.stationPx}px;letter-spacing:.04em;text-align:center;margin:1.5mm 0 2.5mm;">${escapeHtml(data.stationLabel)}</div>
    <div style="font-weight:700;font-size:${t.tablePx}px;text-align:center;margin:0 0 2mm;">STO ${escapeHtml(data.tableLabel)}</div>
    <div style="font-size:${t.metaPx}px;text-align:center;margin:.8mm 0;">NARUDŽBINA #${escapeHtml(data.orderNumber)}</div>
    <div style="font-size:${t.metaPx}px;text-align:center;margin:.8mm 0;">${time}</div>
    <div style="font-size:${t.metaPx}px;text-align:center;margin:.8mm 0;">KONOBAR: ${escapeHtml(data.waiterName)}</div>
    ${additionalHtml}
    <hr style="border:none;border-top:2px dashed #000;margin:2.5mm 0;">
    ${itemsHtml}
    <hr style="border:none;border-top:2px dashed #000;margin:2.5mm 0;">
    <div style="text-align:center;font-size:${t.footerPx}px;margin-top:3mm;">${time}</div>
  </div>`;

  return renderDocument({ widthMm: data.paperWidthMm, heightMm, bodyHtml });
}

/**
 * PrintJob.content dolazi tipizovan kao `unknown` (vidi print-client.ts) —
 * ova funkcija ga bezbedno suzi na oblik koji ovaj fajl zna da renderuje,
 * baca JASNU grešku (nikad tihu pogrešnu štampu) ako sadržaj nije
 * KITCHEN/BAR tiket (jedini oblik koji KDS/QzPrintTransport ikad treba
 * da vidi — vidi print-transport.ts).
 */
export function parseKitchenBarTicketData(content: unknown): QzKitchenBarTicketData {
  if (!content || typeof content !== "object") {
    throw new Error("QZ štampa: nevažeći sadržaj tiketa");
  }
  const c = content as Record<string, unknown>;
  if (c.kind !== "KITCHEN" && c.kind !== "BAR") {
    throw new Error("QZ štampa očekuje KITCHEN/BAR tiket sadržaj");
  }
  return {
    stationLabel: typeof c.stationLabel === "string" ? c.stationLabel : "",
    tableLabel: typeof c.tableLabel === "string" ? c.tableLabel : "",
    orderNumber: typeof c.orderNumber === "string" ? c.orderNumber : "",
    waiterName: typeof c.waiterName === "string" ? c.waiterName : "",
    submittedAt: typeof c.submittedAt === "string" ? c.submittedAt : new Date().toISOString(),
    isAdditional: Boolean(c.isAdditional),
    items: Array.isArray(c.items) ? (c.items as QzTicketItem[]) : [],
    paperWidthMm: typeof c.paperWidthMm === "number" ? c.paperWidthMm : 80,
  };
}

export function buildTestPrintHtml(printerName: string, paperWidthMm: number, heightMm?: number): string {
  const t = typographyFor(paperWidthMm);
  const now = new Date().toLocaleString("sr-RS");
  const [padV, padH] = t.paddingMm;
  const bodyHtml = `<div style="width:${paperWidthMm}mm;padding:${padV}mm ${padH}mm;">
    <div style="font-weight:700;font-size:${t.headerPx}px;letter-spacing:.06em;text-align:center;">TABLECORE</div>
    <div style="font-weight:700;font-size:${t.stationPx}px;letter-spacing:.04em;text-align:center;margin:1.5mm 0 2.5mm;">QZ TEST</div>
    <div style="font-size:${t.metaPx}px;text-align:center;margin:.8mm 0;">Štampač: ${escapeHtml(printerName)}</div>
    <div style="font-size:${t.metaPx}px;text-align:center;margin:.8mm 0;">${escapeHtml(now)}</div>
  </div>`;
  return renderDocument({ widthMm: paperWidthMm, heightMm, bodyHtml });
}
