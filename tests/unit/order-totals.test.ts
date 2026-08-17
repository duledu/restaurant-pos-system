import { describe, it, expect } from "vitest";
import { computeOrderTotals } from "../../packages/domain/orders/order-totals";

describe("computeOrderTotals", () => {
  it("sums subtotal/tax/total for a single line", () => {
    const totals = computeOrderTotals([{ price: "100.00", taxRate: "20", quantity: 2 }]);
    expect(totals.subtotal.toString()).toBe("200");
    expect(totals.tax.toString()).toBe("40");
    expect(totals.total.toString()).toBe("240");
  });

  it("groups tax breakdown by rate across multiple lines", () => {
    const totals = computeOrderTotals([
      { price: "100.00", taxRate: "20", quantity: 1 },
      { price: "50.00", taxRate: "10", quantity: 2 },
      { price: "25.00", taxRate: "20", quantity: 1 },
    ]);
    // 100*1=100 @20% + 25*1=25 @20% => taxable 125, tax 25
    // 50*2=100 @10% => taxable 100, tax 10
    expect(totals.subtotal.toString()).toBe("225");
    expect(totals.tax.toString()).toBe("35");
    expect(totals.total.toString()).toBe("260");
    const byRate = Object.fromEntries(totals.taxBreakdown.map((b) => [b.taxRate, b]));
    expect(byRate["20"].taxableAmount).toBe("125");
    expect(byRate["20"].taxAmount).toBe("25");
    expect(byRate["10"].taxableAmount).toBe("100");
    expect(byRate["10"].taxAmount).toBe("10");
  });

  it("returns zero totals for an empty line list", () => {
    const totals = computeOrderTotals([]);
    expect(totals.subtotal.toString()).toBe("0");
    expect(totals.tax.toString()).toBe("0");
    expect(totals.total.toString()).toBe("0");
    expect(totals.taxBreakdown).toEqual([]);
  });

  it("never produces floating-point drift across many fractional-cent lines", () => {
    // 0.1 + 0.2 style traps are the classic float bug — Decimal must not
    // accumulate error over many additions.
    const lines = Array.from({ length: 1000 }, () => ({ price: "0.10", taxRate: "20", quantity: 1 }));
    const totals = computeOrderTotals(lines);
    expect(totals.subtotal.toString()).toBe("100");
    expect(totals.tax.toString()).toBe("20");
    expect(totals.total.toString()).toBe("120");
  });
});
