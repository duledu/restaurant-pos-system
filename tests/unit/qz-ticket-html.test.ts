import { describe, expect, it } from "vitest";
import {
  buildKitchenBarTicketHtml,
  buildTestPrintHtml,
  parseKitchenBarTicketData,
  type QzKitchenBarTicketData,
} from "../../apps/web/lib/qz-ticket-html";

function ticket(overrides?: Partial<QzKitchenBarTicketData>): QzKitchenBarTicketData {
  return {
    stationLabel: "KUHINJA",
    tableLabel: "5",
    orderNumber: "ABC12345",
    waiterName: "Marko",
    submittedAt: "2026-09-09T10:00:00.000Z",
    isAdditional: false,
    items: [{ quantity: 2, name: "Pljeskavica", note: "bez luka", modifiers: ["+ Kačkavalj"] }],
    paperWidthMm: 80,
    ...overrides,
  };
}

describe("buildKitchenBarTicketHtml — 58mm", () => {
  const html = buildKitchenBarTicketHtml(ticket({ paperWidthMm: 58 }));

  it("sets the true 58mm page and body width, not an A4/page-like default", () => {
    expect(html).toContain("@page { size: 58mm auto; margin: 0; }");
    expect(html).toContain("width: 58mm");
  });

  it("contains no reference to the app's cloned print-ticket-root/stylesheets (no contamination)", () => {
    expect(html).not.toContain("print-ticket-root");
    expect(html).not.toMatch(/<link[^>]*stylesheet/i);
  });

  it("preserves existing data fields: quantity, item name, modifiers, notes", () => {
    expect(html).toContain("2x");
    expect(html).toContain("Pljeskavica");
    expect(html).toContain("Kačkavalj");
    expect(html).toContain("bez luka");
  });

  it("renders Serbian diacritics correctly (utf-8, no mangled escaping)", () => {
    expect(html).toContain("Kačkavalj");
    expect(html).toContain("<meta charset=\"utf-8\">");
  });

  it("embeds an exact content height (mm) as the page height when provided, avoiding blank trailing pages", () => {
    const withHeight = buildKitchenBarTicketHtml(ticket({ paperWidthMm: 58 }), 42);
    expect(withHeight).toContain("@page { size: 58mm 42mm; margin: 0; }");
  });
});

describe("buildKitchenBarTicketHtml — 80mm", () => {
  it("uses the 80mm width/typography, not hardcoded 58mm, when paperWidthMm is 80", () => {
    const html = buildKitchenBarTicketHtml(ticket({ paperWidthMm: 80 }));
    expect(html).toContain("@page { size: 80mm auto; margin: 0; }");
    expect(html).toContain("width: 80mm");
  });
});

describe("buildTestPrintHtml", () => {
  it("respects the requested paper width for the standalone test print document", () => {
    const html58 = buildTestPrintHtml("POS-58 (1)", 58);
    const html80 = buildTestPrintHtml("POS-80 Bar", 80);
    expect(html58).toContain("width: 58mm");
    expect(html80).toContain("width: 80mm");
  });
});

describe("parseKitchenBarTicketData", () => {
  it("accepts a well-formed KITCHEN/BAR PrintJob.content payload", () => {
    const raw = { kind: "KITCHEN", stationLabel: "KUHINJA", tableLabel: "5", orderNumber: "X", waiterName: "M", submittedAt: "2026-01-01T00:00:00.000Z", isAdditional: false, items: [], paperWidthMm: 58 };
    expect(parseKitchenBarTicketData(raw)).toMatchObject({ stationLabel: "KUHINJA", paperWidthMm: 58 });
  });

  it("throws (never silently prints wrong content) for non-KITCHEN/BAR content, e.g. a RECEIPT payload", () => {
    expect(() => parseKitchenBarTicketData({ kind: "RECEIPT" })).toThrow();
  });

  it("throws for null/non-object content", () => {
    expect(() => parseKitchenBarTicketData(null)).toThrow();
    expect(() => parseKitchenBarTicketData("garbage")).toThrow();
  });
});
