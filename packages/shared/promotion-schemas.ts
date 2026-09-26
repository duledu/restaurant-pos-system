import { z } from "zod";

const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum mora biti u obliku GGGG-MM-DD")
  .refine(value => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Datum nije ispravan");

const promotionTargetsSchema = z
  .object({
    menuItemIds: z.array(z.string().uuid()).default([]),
    categoryIds: z.array(z.string().uuid()).default([]),
  })
  .refine((t) => t.menuItemIds.length + t.categoryIds.length > 0, {
    message: "Promocija mora imati bar jedan izabran artikal ili kategoriju",
  });

const promotionScheduleFields = {
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1, "Izaberi bar jedan dan")
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  startTime: z.number().int().min(0).max(1439),
  endTime: z.number().int().min(0).max(1439),
  startDate: ymdSchema.nullable().optional(),
  endDate: ymdSchema.nullable().optional(),
};

function refineNonZeroWindow<T extends { startTime: number; endTime: number }>(data: T, ctx: z.RefinementCtx) {
  if (data.startTime === data.endTime) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Početak i kraj ne mogu biti isto vreme", path: ["endTime"] });
  }
}

const promotionValueFields = {
  type: z.enum(["PERCENTAGE_DISCOUNT", "FIXED_PRICE"]),
  value: z.number().finite().positive().max(9999999999.99).multipleOf(0.01, "Unesi najviše dve decimale"),
};

function refineValueByType<T extends { type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE"; value: number }>(
  data: T,
  ctx: z.RefinementCtx
) {
  if (data.type === "PERCENTAGE_DISCOUNT" && data.value > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Procenat popusta ne može biti veći od 100", path: ["value"] });
  }
}

function refineDateRange(data: { startDate?: string | null; endDate?: string | null }, ctx: z.RefinementCtx) {
  if (data.startDate && data.endDate && data.startDate > data.endDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Kraj perioda ne može biti pre početka", path: ["endDate"] });
  }
}
const prioritySchema = z.number().int().min(-2147483648).max(2147483647);

export const createPromotionSchema = z
  .object({
    name: z.string().trim().min(1, "Naziv je obavezan").max(120),
    description: z.string().max(500).optional(),
    isActive: z.boolean().default(true),
    // null/omitted = važi na svim lokacijama restorana.
    locationId: z.string().uuid().nullable().optional(),
    ...promotionValueFields,
    ...promotionScheduleFields,
    priority: prioritySchema.default(0),
    targets: promotionTargetsSchema,
  })
  .superRefine((data, ctx) => {
    refineNonZeroWindow(data, ctx);
    refineValueByType(data, ctx);
    refineDateRange(data, ctx);
  });
export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;

export const updatePromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
    isActive: z.boolean(),
    locationId: z.string().uuid().nullable().optional(),
    ...promotionValueFields,
    ...promotionScheduleFields,
    priority: prioritySchema,
    targets: promotionTargetsSchema,
  })
  .superRefine((data, ctx) => {
    refineNonZeroWindow(data, ctx);
    refineValueByType(data, ctx);
    refineDateRange(data, ctx);
  });
export type UpdatePromotionInput = z.infer<typeof updatePromotionSchema>;
