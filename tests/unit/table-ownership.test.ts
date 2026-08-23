import { describe, expect, it } from "vitest";
import { isTableHeldByAnotherWaiter } from "../../apps/web/lib/table-ownership";

describe("isTableHeldByAnotherWaiter — pre-navigation waiter ownership check", () => {
  it("returns false when the table has no active order (free table)", () => {
    expect(isTableHeldByAnotherWaiter(null, "emp-1")).toBe(false);
  });

  it("returns false when the active order is owned by the current waiter", () => {
    expect(isTableHeldByAnotherWaiter("emp-1", "emp-1")).toBe(false);
  });

  it("returns true when the active order is owned by a different waiter", () => {
    expect(isTableHeldByAnotherWaiter("emp-1", "emp-2")).toBe(true);
  });

  it("returns true when the current employee id is unknown (null) but the table is owned", () => {
    expect(isTableHeldByAnotherWaiter("emp-1", null)).toBe(true);
  });
});
