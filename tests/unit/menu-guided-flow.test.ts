import { describe, expect, it } from "vitest";
import { decideGuidedFlowAction } from "../../apps/web/app/(admin)/menu/menu-client";

// Inventory Phase 2.5 UX fix — real PREPROD QA found that changing a
// MenuItem's tracking method to RECIPE (or DIRECT_STOCK) saved silently,
// with no obvious next step; the owner had to already know a separate
// "Normativ"/"Zaliha" button existed. decideGuidedFlowAction is the pure
// decision at the heart of the fix — called ONLY after the tracking-method
// save has already succeeded (see setTrackingMethod in menu-client.tsx,
// where this sits inside the try block after the awaited save+reload, so a
// failed save never reaches it — that ordering is structural, not a
// runtime branch this function could get wrong, hence no separate
// "failed save" test case here).
describe("decideGuidedFlowAction — Phase 2.5 guided flow", () => {
  it("NO_TRACKING -> RECIPE opens RecipeModal", () => {
    expect(decideGuidedFlowAction("RECIPE", false)).toBe("OPEN_RECIPE");
  });

  it("DIRECT_STOCK -> RECIPE opens RecipeModal", () => {
    // alreadyLinkedForDirectStock is irrelevant once the NEW method is RECIPE
    expect(decideGuidedFlowAction("RECIPE", true)).toBe("OPEN_RECIPE");
  });

  it("changing to DIRECT_STOCK without existing stock configuration opens DirectStockModal", () => {
    expect(decideGuidedFlowAction("DIRECT_STOCK", false)).toBe("OPEN_DIRECT_STOCK");
  });

  it("changing to DIRECT_STOCK when already configured does NOT force the modal again", () => {
    expect(decideGuidedFlowAction("DIRECT_STOCK", true)).toBe("NONE");
  });

  it("changing to NO_TRACKING never opens a configuration modal", () => {
    expect(decideGuidedFlowAction("NO_TRACKING", false)).toBe("NONE");
    expect(decideGuidedFlowAction("NO_TRACKING", true)).toBe("NONE");
  });
});
