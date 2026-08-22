import { z } from "zod";

export const categoryTypeSchema = z.enum(["FOOD", "DRINK"]);
export const preparationStationSchema = z.enum(["KITCHEN", "BAR", "KITCHEN_AND_BAR", "NONE"]);

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, "Slug sme sadržati samo mala slova, brojeve i crtice"),
  type: categoryTypeSchema,
  sortOrder: z.number().int().default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const reorderCategoriesSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});
export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;

const moneySchema = z
  .number()
  .nonnegative("Cena ne sme biti negativna")
  .max(10_000_000, "Vrednost je nerealno velika — proveri unos");

export const createMenuItemSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, "Slug sme sadržati samo mala slova, brojeve i crtice"),
  description: z.string().trim().max(1000).optional(),
  price: moneySchema,
  taxRate: z.number().min(0).max(100).default(20),
  quantity: z.number().positive().optional(),
  unit: z.string().trim().max(20).optional(),
  sku: z.string().trim().max(64).optional(),
  barcode: z.string().trim().max(64).optional(),
  purchasePrice: moneySchema.optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  isAvailable: z.boolean().default(true),
  trackStock: z.boolean().default(false),
  minimumStock: z.number().nonnegative().optional(),
  preparationStation: preparationStationSchema.default("NONE"),
  needsReview: z.boolean().default(false),
  reviewNote: z.string().trim().max(500).optional(),
});
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;

export const updateMenuItemSchema = createMenuItemSchema.partial();
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;

export const changePriceSchema = z.object({
  price: moneySchema,
  reason: z.string().trim().max(300).optional(),
});
export type ChangePriceInput = z.infer<typeof changePriceSchema>;

export const moveToCategorySchema = z.object({
  categoryId: z.string().uuid().nullable(),
});
export type MoveToCategoryInput = z.infer<typeof moveToCategorySchema>;

// ── P3.2: MODIFIKATORI / DODACI ────────────────────────────────────────

export const createModifierGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  required: z.boolean().default(false),
  minSelect: z.number().int().nonnegative().default(0),
  maxSelect: z.number().int().positive().default(1),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type CreateModifierGroupInput = z.infer<typeof createModifierGroupSchema>;

export const updateModifierGroupSchema = createModifierGroupSchema.partial();
export type UpdateModifierGroupInput = z.infer<typeof updateModifierGroupSchema>;

const priceDeltaSchema = z
  .number()
  // Modifikatori su tipično dodaci (>= 0); dozvoljen mali negativan opseg
  // radi buduće fleksibilnosti (npr. "manja porcija -50") bez otvaranja
  // vrata za nerealne popuste kroz "cenu opcije".
  .min(-100_000, "Vrednost je nerealno velika — proveri unos")
  .max(1_000_000, "Vrednost je nerealno velika — proveri unos");

export const createModifierOptionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  priceDelta: priceDeltaSchema.default(0),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type CreateModifierOptionInput = z.infer<typeof createModifierOptionSchema>;

export const updateModifierOptionSchema = createModifierOptionSchema.partial();
export type UpdateModifierOptionInput = z.infer<typeof updateModifierOptionSchema>;

export const menuItemFiltersSchema = z.object({
  search: z.string().trim().max(200).optional(),
  categoryId: z.string().uuid().optional(),
  type: categoryTypeSchema.optional(),
  preparationStation: preparationStationSchema.optional(),
  activeOnly: z.boolean().optional(),
  // P3.3: kad je prosleđeno, listMenuItems dodaje batch-ovan status zaliha
  // (OUT/LOW/OK) za TU lokaciju uz svaki artikal — vidi menu-service.ts.
  // Opciono jer Admin Menu pregled (bez konkretne lokacije) ostaje nepromenjen.
  locationId: z.string().uuid().optional(),
});
export type MenuItemFilters = z.infer<typeof menuItemFiltersSchema>;
