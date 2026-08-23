import { describe, expect, it } from "vitest";
import { convertUnit, unitDimension, unitLabelSr, ALL_UNITS, UNIT_LABELS_SR } from "../../packages/domain/inventory/unit-of-measure";

describe("unit-of-measure — P1 conversion table", () => {
  it("converts kilogram to gram and back", () => {
    expect(convertUnit(1, "KILOGRAM", "GRAM")).toBe(1000);
    expect(convertUnit(1000, "GRAM", "KILOGRAM")).toBe(1);
    expect(convertUnit(0.2, "KILOGRAM", "GRAM")).toBeCloseTo(200, 9);
  });

  it("converts liter to milliliter and back", () => {
    expect(convertUnit(1, "LITER", "MILLILITER")).toBe(1000);
    expect(convertUnit(1000, "MILLILITER", "LITER")).toBe(1);
    expect(convertUnit(0.01, "LITER", "MILLILITER")).toBeCloseTo(10, 9);
  });

  it("same-unit conversion is a no-op", () => {
    expect(convertUnit(5, "KILOGRAM", "KILOGRAM")).toBe(5);
    expect(convertUnit(5, "PIECE", "PIECE")).toBe(5);
  });

  it("rejects converting across dimensions (mass <-> volume)", () => {
    expect(() => convertUnit(1, "KILOGRAM", "LITER")).toThrow();
    expect(() => convertUnit(1, "GRAM", "MILLILITER")).toThrow();
  });

  it("rejects converting PIECE to/from any mass or volume unit — pieces are discrete", () => {
    expect(() => convertUnit(1, "PIECE", "KILOGRAM")).toThrow();
    expect(() => convertUnit(1, "GRAM", "PIECE")).toThrow();
  });

  it("Serbian labels cover every unit", () => {
    for (const unit of ALL_UNITS) {
      expect(UNIT_LABELS_SR[unit]).toBeTruthy();
      expect(unitLabelSr(unit)).toBe(UNIT_LABELS_SR[unit]);
    }
    expect(unitLabelSr("KILOGRAM")).toBe("kg");
    expect(unitLabelSr("GRAM")).toBe("g");
    expect(unitLabelSr("LITER")).toBe("l");
    expect(unitLabelSr("MILLILITER")).toBe("ml");
    expect(unitLabelSr("PIECE")).toBe("kom");
  });

  it("classifies unit dimensions correctly", () => {
    expect(unitDimension("KILOGRAM")).toBe("MASS");
    expect(unitDimension("GRAM")).toBe("MASS");
    expect(unitDimension("LITER")).toBe("VOLUME");
    expect(unitDimension("MILLILITER")).toBe("VOLUME");
    expect(unitDimension("PIECE")).toBe("COUNT");
  });
});
