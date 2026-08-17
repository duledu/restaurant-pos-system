import { describe, expect, it } from "vitest";
import { aggregateStationStatus, stationsForPreparation } from "../../packages/domain/production/station-state";

describe("production station routing", () => {
  it("routes KITCHEN only to kitchen", () => {
    expect(stationsForPreparation("KITCHEN")).toEqual(["KITCHEN"]);
  });

  it("routes BAR only to bar", () => {
    expect(stationsForPreparation("BAR")).toEqual(["BAR"]);
  });

  it("routes KITCHEN_AND_BAR independently to both stations", () => {
    expect(stationsForPreparation("KITCHEN_AND_BAR")).toEqual(["KITCHEN", "BAR"]);
  });

  it("creates no production route for NONE", () => {
    expect(stationsForPreparation("NONE")).toEqual([]);
  });
});

describe("OrderItem aggregate production status", () => {
  it("uses the least-advanced required station", () => {
    expect(aggregateStationStatus(["READY", "ACCEPTED"])).toBe("ACCEPTED");
  });

  it("becomes READY only after both stations are ready", () => {
    expect(aggregateStationStatus(["READY", "READY"])).toBe("READY");
  });

  it("treats an item with no production station as served", () => {
    expect(aggregateStationStatus([])).toBe("SERVED");
  });
});
