import { z } from "zod";

export const updateRestaurantSettingsSchema = z.object({
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  taxIdNumber: z.string().trim().max(50).nullable().optional(),
  receiptFooterText: z.string().trim().max(300).nullable().optional(),
  receiptLegalNote: z.string().trim().max(300).nullable().optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
  showTaxBreakdown: z.boolean().optional(),
});
export type UpdateRestaurantSettingsInput = z.infer<typeof updateRestaurantSettingsSchema>;

// RECEIPT RENDERING POLISH — the admin restaurant-settings API route accepts
// this superset (restaurant identity + the RestaurantSettings fields above)
// as ONE request body, then splits it server-side: `name` updates
// Restaurant.name (a different table), the rest updates RestaurantSettings.
// Kept separate from updateRestaurantSettingsSchema itself so the domain
// function that only ever touches RestaurantSettings never has to reason
// about a field from an unrelated model.
export const adminRestaurantSettingsPutSchema = updateRestaurantSettingsSchema.extend({
  name: z.string().trim().min(1).max(200).optional(),
});
export type AdminRestaurantSettingsPutInput = z.infer<typeof adminRestaurantSettingsPutSchema>;

export const printerConfigSchema = z.object({
  locationId: z.string().uuid(),
  station: z.enum(["KITCHEN", "BAR", "RECEIPT"]),
  name: z.string().trim().min(1).max(100),
  printerType: z.enum(["BROWSER", "ESC_POS_LAN", "NETWORK"]).default("BROWSER"),
  paperWidthMm: z.number().int().positive().default(80),
  isEnabled: z.boolean().default(true),
  autoPrint: z.boolean().default(false),
  copies: z.number().int().min(1).max(10).default(1),
  ipAddress: z.string().trim().max(64).nullable().optional(),
  port: z.number().int().positive().nullable().optional(),
});
export type PrinterConfigInput = z.infer<typeof printerConfigSchema>;
