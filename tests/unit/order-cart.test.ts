import { describe, expect, it } from "vitest";
import { sameModifierSelection } from "../../apps/web/lib/order-cart";

describe("sameModifierSelection — order-line merge identity (P3.2 #46/#47)", () => {
  it("treats an identical modifier set as the same line regardless of click/selection order", () => {
    const existing = [{ modifierOptionId: "cheese" }, { modifierOptionId: "bacon" }];
    expect(sameModifierSelection(existing, ["cheese", "bacon"])).toBe(true);
    expect(sameModifierSelection(existing, ["bacon", "cheese"])).toBe(true);
  });

  it("treats a different modifier set as a different line (Burger+cheese != Burger+bacon)", () => {
    const existing = [{ modifierOptionId: "cheese" }];
    expect(sameModifierSelection(existing, ["bacon"])).toBe(false);
  });

  it("treats no-modifiers vs some-modifiers as different lines", () => {
    expect(sameModifierSelection([], ["cheese"])).toBe(false);
    expect(sameModifierSelection([{ modifierOptionId: "cheese" }], [])).toBe(false);
  });

  it("treats two plain (no-modifier) lines as the same line", () => {
    expect(sameModifierSelection([], [])).toBe(true);
  });

  it("treats a subset as different from the full set (Burger+cheese != Burger+cheese+bacon)", () => {
    const existing = [{ modifierOptionId: "cheese" }, { modifierOptionId: "bacon" }];
    expect(sameModifierSelection(existing, ["cheese"])).toBe(false);
  });
});
