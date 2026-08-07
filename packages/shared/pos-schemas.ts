import { z } from "zod";

export const openShiftSchema = z.object({
  locationId: z.string().uuid(),
  openingCash: z.number().nonnegative().default(0),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

export const openOrderSchema = z.object({
  tableId: z.string().uuid(),
  guestCount: z.number().int().positive().max(50).optional(),
});
export type OpenOrderInput = z.infer<typeof openOrderSchema>;

export const addOrderItemSchema = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(50).default(1),
  note: z.string().trim().max(300).optional(),
});
export type AddOrderItemInput = z.infer<typeof addOrderItemSchema>;

export const updateOrderItemSchema = z.object({
  quantity: z.number().int().min(1).max(50).optional(),
  note: z.string().trim().max(300).optional(),
});
export type UpdateOrderItemInput = z.infer<typeof updateOrderItemSchema>;

export const submitOrderSchema = z.object({
  // Klijent generiše UUID PRE prvog pokušaja slanja i šalje isti ključ na
  // svaki retry (mrežni retry, duplo kliknuto dugme) — server garantuje da
  // isti ključ nikad ne kreira drugu porudžbinu (vidi Order.idempotencyKey
  // unique constraint).
  idempotencyKey: z.string().uuid(),
});
export type SubmitOrderInput = z.infer<typeof submitOrderSchema>;
