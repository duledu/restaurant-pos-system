import { describe, it, expect } from "vitest";
import { percentChange, safeDiv, decimalToNumber, round2 } from "../../packages/domain/analytics/analytics-utils";

describe("percentChange — never Infinity/NaN, null when previous is 0", () => {
  it("computes a positive change correctly", () => {
    expect(percentChange(120, 100)).toBe(20);
  });

  it("computes a negative change correctly", () => {
    expect(percentChange(80, 100)).toBe(-20);
  });

  it("returns null (not Infinity) when previous is 0", () => {
    expect(percentChange(100, 0)).toBeNull();
  });

  it("returns null when previous is 0 even if current is also 0", () => {
    expect(percentChange(0, 0)).toBeNull();
  });

  it("returns null (not NaN) for non-finite inputs", () => {
    expect(percentChange(NaN, 100)).toBeNull();
    expect(percentChange(100, NaN)).toBeNull();
    expect(percentChange(Infinity, 100)).toBeNull();
  });

  it("rounds to one decimal place", () => {
    expect(percentChange(133, 100)).toBe(33);
    expect(percentChange(101, 100)).toBe(1);
  });
});

describe("safeDiv — null instead of Infinity/NaN on zero denominator", () => {
  it("divides normally", () => {
    expect(safeDiv(10, 4)).toBe(2.5);
  });

  it("returns null when denominator is 0", () => {
    expect(safeDiv(10, 0)).toBeNull();
    expect(safeDiv(0, 0)).toBeNull();
  });
});

describe("decimalToNumber", () => {
  it("converts a numeric string", () => {
    expect(decimalToNumber("123.45")).toBe(123.45);
  });
  it("treats null/undefined as 0", () => {
    expect(decimalToNumber(null)).toBe(0);
    expect(decimalToNumber(undefined)).toBe(0);
  });
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.005)).toBeCloseTo(1.0, 1);
    expect(round2(10.126)).toBe(10.13);
  });
});
