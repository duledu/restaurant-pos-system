import { describe, expect, it } from "vitest";
import { naturalCompare, sortByLabelNatural } from "../../packages/shared/natural-sort";

describe("naturalCompare — numeric-aware table label ordering", () => {
  it("orders 'Sto N' labels numerically, not lexicographically", () => {
    const labels = ["Sto 10", "Sto 2", "Sto 1", "Sto 9", "Sto 3"];
    expect([...labels].sort(naturalCompare)).toEqual(["Sto 1", "Sto 2", "Sto 3", "Sto 9", "Sto 10"]);
  });

  it("Sto 10 comes after Sto 9, never right after Sto 1", () => {
    expect(naturalCompare("Sto 1", "Sto 10")).toBeLessThan(0);
    expect(naturalCompare("Sto 9", "Sto 10")).toBeLessThan(0);
    expect(naturalCompare("Sto 10", "Sto 9")).toBeGreaterThan(0);
  });

  it("falls back to safe alphabetical ordering for non-numeric labels", () => {
    const labels = ["VIP", "Bašta", "Terasa"];
    expect([...labels].sort(naturalCompare)).toEqual(["Bašta", "Terasa", "VIP"]);
  });

  it("handles a mix of purely numeric and text-plus-number labels without crashing", () => {
    const labels = ["Sto 10", "VIP", "Sto 2", "Bašta 1", "Bašta 10", "Bašta 2"];
    expect([...labels].sort(naturalCompare)).toEqual(["Bašta 1", "Bašta 2", "Bašta 10", "Sto 2", "Sto 10", "VIP"]);
  });
});

describe("sortByLabelNatural — applied to table-like objects", () => {
  it("sorts a list of {label} objects into natural order, without mutating the input array", () => {
    const tables = [{ id: "a", label: "Sto 10" }, { id: "b", label: "Sto 1" }, { id: "c", label: "Sto 2" }];
    const sorted = sortByLabelNatural(tables);
    expect(sorted.map((t) => t.label)).toEqual(["Sto 1", "Sto 2", "Sto 10"]);
    expect(tables.map((t) => t.label)).toEqual(["Sto 10", "Sto 1", "Sto 2"]); // original untouched
  });
});
