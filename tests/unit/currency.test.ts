import { describe, it, expect } from "vitest";
import { formatMoney, formatNumber } from "../../packages/shared/currency";

describe("formatMoney", () => {
  it("formats a number with the default RSD currency", () => {
    expect(formatMoney(124850)).toBe("124.850,00 RSD");
  });

  it("formats a string decimal", () => {
    expect(formatMoney("1452.5")).toBe("1.452,50 RSD");
  });

  it("supports a different currency code", () => {
    expect(formatMoney(10, "EUR")).toBe("10,00 EUR");
  });

  it("treats non-finite input as zero rather than throwing", () => {
    expect(formatMoney(Number.NaN)).toBe("0,00 RSD");
  });
});

describe("formatNumber", () => {
  it("formats without a currency suffix", () => {
    expect(formatNumber(1234.5)).toBe("1.234,50");
  });
});
