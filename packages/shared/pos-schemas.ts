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
  // P3.2: SAMO identiteti (option ID-jevi) — NIKAD cena sa klijenta (server
  // presuđuje trenutnu dozvoljenu cenu i zamrzava je, vidi modifier-service.ts).
  modifierOptionIds: z.array(z.string().uuid()).max(50).default([]),
});
export type AddOrderItemInput = z.infer<typeof addOrderItemSchema>;

export const updateOrderItemModifiersSchema = z.object({
  modifierOptionIds: z.array(z.string().uuid()).max(50).default([]),
});
export type UpdateOrderItemModifiersInput = z.infer<typeof updateOrderItemModifiersSchema>;

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

// ── FAZA 6: ŠTAMPA / POPUST ─────────────────────────────────────────────

export const applyOrderDiscountSchema = z.object({
  amount: z.number().nonnegative(),
  reason: z.string().trim().min(1, "Razlog popusta je obavezan").max(300),
});
export type ApplyOrderDiscountInput = z.infer<typeof applyOrderDiscountSchema>;

export const reprintReceiptSchema = z.object({
  // Klijent generiše UUID po kliku na "Reprint" — isti obrazac kao
  // submitOrderSchema.idempotencyKey (vidi print-service.ts).
  idempotencyKey: z.string().uuid(),
});
export type ReprintReceiptInput = z.infer<typeof reprintReceiptSchema>;

export const confirmPrintResultSchema = z.object({
  success: z.boolean(),
  errorMessage: z.string().trim().max(500).optional(),
});
export type ConfirmPrintResultInput = z.infer<typeof confirmPrintResultSchema>;

// ── FAZA 8: SPLIT BILL / TRANSFER STAVKI ─────────────────────────────────

export const splitBillLineSchema = z.object({
  orderItemId: z.string().uuid(),
  quantity: z.number().int().min(1),
});

export const splitBillPaySchema = z.object({
  // Isti idempotency obrazac kao submitOrderSchema/completePaymentSchema —
  // klijent generiše UUID pre prvog pokušaja i šalje isti ključ na svaki
  // retry (server garantuje da isti ključ nikad ne naplati dvaput, vidi
  // Payment.@@unique([orderId, idempotencyKey])).
  idempotencyKey: z.string().uuid(),
  method: z.enum(["CASH", "CARD"]),
  tenderedAmount: z.number().nonnegative().optional(),
  lines: z.array(splitBillLineSchema).min(1).max(100),
});
export type SplitBillPayInput = z.infer<typeof splitBillPaySchema>;

export const transferOrderItemsSchema = z.object({
  destinationTableId: z.string().uuid(),
  lines: z.array(splitBillLineSchema).min(1).max(100),
});
export type TransferOrderItemsInput = z.infer<typeof transferOrderItemsSchema>;

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
