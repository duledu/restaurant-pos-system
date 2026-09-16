/**
 * RECEIPT RENDERING POLISH — pure Zod schema validation for the admin
 * restaurant-settings request shape. DB-independent (no fixture, no
 * prisma), so unlike the integration test matrix for this same feature
 * (tests/integration/receipt-rendering.test.ts, blocked in this sandbox —
 * see its own header comment), this one actually runs here.
 */
import { describe, expect, it } from "vitest";
import { updateRestaurantSettingsSchema, adminRestaurantSettingsPutSchema } from "../../packages/shared/settings-schemas";

describe("updateRestaurantSettingsSchema", () => {
  it("accepts a partial update including the new showTaxBreakdown toggle", () => {
    const parsed = updateRestaurantSettingsSchema.parse({ showTaxBreakdown: false });
    expect(parsed.showTaxBreakdown).toBe(false);
  });

  it("showTaxBreakdown is optional — omitting it never forces a value", () => {
    const parsed = updateRestaurantSettingsSchema.parse({ address: "Ulica 1" });
    expect(parsed.showTaxBreakdown).toBeUndefined();
  });

  it("rejects a non-boolean showTaxBreakdown", () => {
    expect(() => updateRestaurantSettingsSchema.parse({ showTaxBreakdown: "yes" })).toThrow();
  });

  it("still accepts an empty object (no-op save)", () => {
    expect(() => updateRestaurantSettingsSchema.parse({})).not.toThrow();
  });
});

describe("adminRestaurantSettingsPutSchema — restaurant name + settings in one request", () => {
  it("accepts a name alongside settings fields", () => {
    const parsed = adminRestaurantSettingsPutSchema.parse({ name: "Restoran Stari Hrast", showTaxBreakdown: true });
    expect(parsed.name).toBe("Restoran Stari Hrast");
    expect(parsed.showTaxBreakdown).toBe(true);
  });

  it("trims the name and rejects a blank/whitespace-only one", () => {
    expect(adminRestaurantSettingsPutSchema.parse({ name: "  Stari Hrast  " }).name).toBe("Stari Hrast");
    expect(() => adminRestaurantSettingsPutSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects a name over 200 characters", () => {
    expect(() => adminRestaurantSettingsPutSchema.parse({ name: "a".repeat(201) })).toThrow();
  });

  it("name is optional — a request that only changes VAT display never has to resend the name", () => {
    const parsed = adminRestaurantSettingsPutSchema.parse({ showTaxBreakdown: false });
    expect(parsed.name).toBeUndefined();
  });
});
