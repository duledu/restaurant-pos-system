import { describe, expect, it } from "vitest";
import { canonicalRecipeQuantity } from "../../packages/domain/menu/recipe-service";
import { convertUnit } from "../../packages/domain/inventory/unit-of-measure";

// Physical QA finding — a Normativ line was saved as "Jaja (kom) = 0.002"
// instead of 2. Traced the full pipeline (unit-of-measure.ts conversion
// math, RecipeModal.tsx's add/edit forms, recipe-service.ts's add/update
// handlers): no step silently divides a PIECE quantity — the root cause
// was canonicalRecipeQuantity never requiring a discrete (COUNT-dimension)
// quantity to be a whole number. These tests pin exactly the behavior the
// physical bug exposed, plus the existing mass/volume math it must never
// regress alongside the new guard.
describe("canonicalRecipeQuantity — discrete (PIECE) quantities must stay whole numbers", () => {
  it("accepts 2 kom and persists it as exactly 2, not a fraction", () => {
    expect(canonicalRecipeQuantity(2, "PIECE", "PIECE").toNumber()).toBe(2);
  });

  it("rejects a fractional PIECE quantity — the exact physical bug (0.002 kom)", () => {
    expect(() => canonicalRecipeQuantity(0.002, "PIECE", "PIECE")).toThrow("ceo broj");
  });

  it("rejects any non-integer PIECE quantity, not just the one reported value", () => {
    expect(() => canonicalRecipeQuantity(1.5, "PIECE", "PIECE")).toThrow("ceo broj");
    expect(() => canonicalRecipeQuantity(0.5, "PIECE", "PIECE")).toThrow("ceo broj");
  });

  it("sale-deduction math on a correctly-stored 2 kom line: 1 sale removes 2, 3 sales remove 6", () => {
    const stored = canonicalRecipeQuantity(2, "PIECE", "PIECE");
    expect(stored.mul(1).toNumber()).toBe(2);
    expect(stored.mul(3).toNumber()).toBe(6);
  });

  it("mass/volume quantities are unaffected by the new integer guard (fractional kg/ml stay legal)", () => {
    expect(canonicalRecipeQuantity(0.3, "KILOGRAM", "KILOGRAM").toNumber()).toBe(0.3);
    expect(canonicalRecipeQuantity(0.04, "LITER", "LITER").toNumber()).toBe(0.04);
  });
});

describe("unit-of-measure — additional mass/volume regressions from physical QA", () => {
  it("Punjena pljeskavica scaling: 300 g meat / 30 g cheese / 30 g prosciutto doubles cleanly to x2", () => {
    expect(convertUnit(300, "GRAM", "GRAM") * 2).toBe(600);
    expect(convertUnit(30, "GRAM", "GRAM") * 2).toBe(60);
  });

  it("Vinjak: 40 ml per serving x 25 servings consumes exactly 1 l, no remainder", () => {
    const totalMl = 40 * 25;
    expect(totalMl).toBe(1000);
    expect(convertUnit(totalMl, "MILLILITER", "LITER")).toBe(1);
  });
});
