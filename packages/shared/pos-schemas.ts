import { z } from "zod";
import { VOID_REASON_CODES } from "./void-reasons";

export const openShiftSchema = z.object({
  locationId: z.string().uuid(),
  openingCash: z.number().nonnegative().default(0),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

export const closeShiftSchema = z.object({
  countedCash: z.number().nonnegative(),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

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

export const completePaymentSchema = z.object({
  method: z.enum(["CASH", "CARD"]),
  // Samo za CASH, samo za obračun kusura — NIKAD se ne koristi kao iznos
  // naplate (taj se uvek računa na serveru iz OrderItem redova).
  tenderedAmount: z.number().nonnegative().optional(),
});
export type CompletePaymentInput = z.infer<typeof completePaymentSchema>;

export const voidOrderItemSchema = z.object({
  quantity: z.number().int().min(1),
  reasonCode: z.enum(VOID_REASON_CODES),
  // Namerno samo oblik ovde (obavezno, razumna dužina) — STVARNA provera
  // smislenosti (isMeaningfulVoidExplanation) radi se u void-service.ts, ne
  // ovde, isto kao što billing-service (ne zod) proverava iznos gotovine —
  // domenska pravila žive u servisu, zod samo u obliku ulaza.
  explanation: z.string().trim().min(1, "Obrazloženje je obavezno").max(500),
});
export type VoidOrderItemInput = z.infer<typeof voidOrderItemSchema>;
