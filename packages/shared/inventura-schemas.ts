import { z } from "zod";

// ── INVENTURA (fizičko prebrojavanje zaliha) ──────────────────────────────

export const startInventoryCountSessionSchema = z.object({
  locationId: z.string().uuid(),
});
export type StartInventoryCountSessionInput = z.infer<typeof startInventoryCountSessionSchema>;

export const inventoryCountTargetSchema = z.object({
  targetType: z.enum(["INGREDIENT", "MENU_ITEM"]),
  ingredientId: z.string().uuid().optional(),
  menuItemId: z.string().uuid().optional(),
});

export const addInventoryCountLinesSchema = z.object({
  targets: z.array(inventoryCountTargetSchema).min(1).max(200),
});
export type AddInventoryCountLinesInput = z.infer<typeof addInventoryCountLinesSchema>;

export const enterInventoryCountPhysicalQtySchema = z.object({
  physicalQty: z.number().nonnegative(),
});
export type EnterInventoryCountPhysicalQtyInput = z.infer<typeof enterInventoryCountPhysicalQtySchema>;

export const confirmInventoryCountSessionSchema = z.object({
  overrideStaleLineIds: z.array(z.string().uuid()).max(200).optional(),
});
export type ConfirmInventoryCountSessionInput = z.infer<typeof confirmInventoryCountSessionSchema>;
