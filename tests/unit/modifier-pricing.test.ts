import { describe, expect, it } from "vitest";
import { modifiers } from "@rcs/domain";
import type { ModifierGroupForValidation } from "@rcs/domain/menu/modifier-service";

const { validateAndPriceModifierSelection } = modifiers;

function group(overrides: Partial<ModifierGroupForValidation> = {}): ModifierGroupForValidation {
  return {
    id: "g1",
    name: "Dodaci",
    required: false,
    minSelect: 0,
    maxSelect: 5,
    isActive: true,
    options: [
      { id: "o1", name: "Kačkavalj", priceDelta: "100", isActive: true },
      { id: "o2", name: "Slanina", priceDelta: "150", isActive: true },
      { id: "o3", name: "Jaje", priceDelta: "80", isActive: true },
    ],
    ...overrides,
  };
}

describe("validateAndPriceModifierSelection — pricing", () => {
  it("prices a single modifier: base handled by caller, this returns only the delta", () => {
    const result = validateAndPriceModifierSelection([group()], ["o1"]);
    expect(result.priceDelta.toString()).toBe("100");
    expect(result.snapshotRows).toHaveLength(1);
    expect(result.snapshotRows[0]).toMatchObject({ modifierOptionId: "o1", groupName: "Dodaci", optionName: "Kačkavalj", sortOrder: 0 });
  });

  it("sums multiple modifiers correctly (100 + 150 = 250)", () => {
    const result = validateAndPriceModifierSelection([group()], ["o1", "o2"]);
    expect(result.priceDelta.toString()).toBe("250");
  });

  it("returns zero delta for a zero-price modifier (e.g. 'Bez luka')", () => {
    const g = group({ options: [{ id: "o4", name: "Bez luka", priceDelta: "0", isActive: true }] });
    const result = validateAndPriceModifierSelection([g], ["o4"]);
    expect(result.priceDelta.toString()).toBe("0");
  });

  it("returns zero delta and no rows for an empty selection", () => {
    const result = validateAndPriceModifierSelection([group()], []);
    expect(result.priceDelta.toString()).toBe("0");
    expect(result.snapshotRows).toEqual([]);
  });

  it("de-duplicates a repeated option id defensively (client tamper/double-submit)", () => {
    const result = validateAndPriceModifierSelection([group()], ["o1", "o1"]);
    expect(result.snapshotRows).toHaveLength(1);
    expect(result.priceDelta.toString()).toBe("100");
  });
});

describe("validateAndPriceModifierSelection — required/min/max validation", () => {
  it("rejects a missing selection for a required group", () => {
    const g = group({ required: true, minSelect: 1, maxSelect: 1 });
    expect(() => validateAndPriceModifierSelection([g], [])).toThrow(/zahteva izbor/);
  });

  it("accepts a required group when satisfied", () => {
    const g = group({ required: true, minSelect: 1, maxSelect: 1 });
    const result = validateAndPriceModifierSelection([g], ["o1"]);
    expect(result.priceDelta.toString()).toBe("100");
  });

  it("rejects fewer selections than minSelect on an optional-but-min>0 group", () => {
    const g = group({ required: false, minSelect: 2, maxSelect: 3 });
    expect(() => validateAndPriceModifierSelection([g], ["o1"])).toThrow(/najmanje 2/);
  });

  it("rejects more selections than maxSelect", () => {
    const g = group({ maxSelect: 2 });
    expect(() => validateAndPriceModifierSelection([g], ["o1", "o2", "o3"])).toThrow(/najviše 2/);
  });

  it("allows exactly maxSelect selections", () => {
    const g = group({ maxSelect: 2 });
    const result = validateAndPriceModifierSelection([g], ["o1", "o2"]);
    expect(result.snapshotRows).toHaveLength(2);
  });
});

describe("validateAndPriceModifierSelection — invalid/cross-group/inactive rejection", () => {
  it("rejects an option ID that does not belong to any provided group (cross-item/cross-group tamper)", () => {
    expect(() => validateAndPriceModifierSelection([group()], ["does-not-exist"])).toThrow(/ne pripada/);
  });

  it("rejects an option from a DIFFERENT group not attached to this item (server-side, not just UI)", () => {
    const attachedGroup = group({ id: "g1" });
    const otherItemsGroupOption = "o-from-another-item";
    // otherItemsGroupOption nije ni u jednoj od PROSLEĐENIH grupa — simulira
    // pokušaj slanja ID-ja opcije koja pripada grupi vezanoj za DRUGI artikal.
    expect(() => validateAndPriceModifierSelection([attachedGroup], [otherItemsGroupOption])).toThrow();
  });

  it("rejects an inactive option — cannot be newly ordered", () => {
    const g = group({ options: [{ id: "o1", name: "Kačkavalj", priceDelta: "100", isActive: false }] });
    expect(() => validateAndPriceModifierSelection([g], ["o1"])).toThrow(/nije dostupna/);
  });

  it("rejects any selection from an inactive group", () => {
    const g = group({ isActive: false });
    expect(() => validateAndPriceModifierSelection([g], ["o1"])).toThrow(/nije aktivna/);
  });

  it("ignores (does not require) an inactive group with required=true — an inactive group is not shown/enforced", () => {
    const g = group({ isActive: false, required: true, minSelect: 1 });
    const result = validateAndPriceModifierSelection([g], []);
    expect(result.priceDelta.toString()).toBe("0");
  });
});

describe("validateAndPriceModifierSelection — selection order independence", () => {
  it("produces the same price delta regardless of the order option IDs are submitted", () => {
    const g = group();
    const a = validateAndPriceModifierSelection([g], ["o1", "o2"]);
    const b = validateAndPriceModifierSelection([g], ["o2", "o1"]);
    expect(a.priceDelta.toString()).toBe(b.priceDelta.toString());
  });
});
