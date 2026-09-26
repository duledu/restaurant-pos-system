import { describe, expect, it } from "vitest";
import { createPromotionSchema, updatePromotionSchema } from "../../packages/shared/promotion-schemas";

const valid = {
  name: "Happy Hour", isActive: true, type: "PERCENTAGE_DISCOUNT", value: 20,
  daysOfWeek: [1, 2, 3, 4, 5], startTime: 1020, endTime: 1140, priority: 0,
  targets: { menuItemIds: ["00000000-0000-4000-8000-000000000001"], categoryIds: [] },
};
describe.each([createPromotionSchema, updatePromotionSchema])("promotion input validation", schema => {
  it.each([
    { startDate: "2026-02-30" }, { startDate: "2026-13-01" },
    { startDate: "2026-02-01", endDate: "2026-01-01" },
    { value: 100.01 }, { value: 0 }, { value: 12.345 },
    { type: "FIXED_PRICE", value: 10000000000 }, { priority: 2147483648 },
    { startTime: 1140 }, { targets: { menuItemIds: [], categoryIds: [] } },
  ])("rejects invalid configuration %j", change => {
    expect(schema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
  it("accepts two-decimal values, equal calendar dates, and cross-midnight windows", () => {
    expect(schema.safeParse({ ...valid, value: 12.34, startDate: "2028-02-29", endDate: "2028-02-29", startTime: 1320, endTime: 120 }).success).toBe(true);
  });
});
