import { describe, expect, it } from "vitest";
import { formatStockQty } from "../../apps/web/lib/stock-format";

describe("formatStockQty — decimal-safe stock quantity display (P3.3 #37)", () => {
  it("formats whole numbers without trailing decimals", () => {
    expect(formatStockQty("3.000")).toBe("3");
    expect(formatStockQty(10)).toBe("10");
  });

  it("preserves meaningful decimal precision (Decimal(12,3) values)", () => {
    expect(formatStockQty("2.500")).toBe("2.5");
    expect(formatStockQty("0.750")).toBe("0.75");
  });

  it("handles zero and invalid input safely, never NaN/undefined text", () => {
    expect(formatStockQty("0")).toBe("0");
    expect(formatStockQty("not-a-number")).toBe("0");
  });
});
