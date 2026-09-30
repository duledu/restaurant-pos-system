import { describe, expect, it } from "vitest";
import { countLabel } from "../../apps/web/app/m/[slug]/guest-order";

// Physical QA "4 stavke / 3 stavke" regression — a guest cart of Omlet x2 +
// Ordever x1 + Coca-Cola x1 is 3 unique lines AND 4 total units, both
// correct at once. countLabel must make that explicit instead of
// collapsing to one ambiguous "stavke" number that reads as data loss.
describe("countLabel — disambiguates unique lines from total quantity", () => {
  it("shows a single count when every line has quantity 1 (lines === units)", () => {
    expect(countLabel(3, 3)).toBe("3 artikla");
    expect(countLabel(1, 1)).toBe("1 artikal");
  });

  it("shows both counts when any line has quantity > 1 (lines !== units)", () => {
    // Omlet x2, Ordever x1, Coca-Cola x1: 3 lines, 4 units.
    expect(countLabel(3, 4)).toBe("3 artikla · 4 kom.");
  });

  it("uses singular 'artikal' only for exactly one line, regardless of total units", () => {
    expect(countLabel(1, 5)).toBe("1 artikal · 5 kom.");
  });
});
