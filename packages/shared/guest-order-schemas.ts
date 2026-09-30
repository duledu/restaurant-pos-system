import { z } from "zod";

// P0 GUEST QR ORDERING — public, unauthenticated input. Deliberately tight
// caps (restaurant-scale sanity, not a real ordering limit any genuine guest
// would hit) — this is the first line of abuse protection for a public
// endpoint with no session/rate context of its own.
const MAX_LINE_ITEMS = 20;
const MAX_QUANTITY_PER_LINE = 20;
const MAX_NOTE_LENGTH = 140;

export const finalizeGuestOrderItemSchema = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
  note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
});

export const finalizeGuestOrderSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(60),
  items: z.array(finalizeGuestOrderItemSchema).min(1, "Porudžbina je prazna").max(MAX_LINE_ITEMS, "Previše stavki u jednoj porudžbini"),
});
export type FinalizeGuestOrderInput = z.infer<typeof finalizeGuestOrderSchema>;

// Opaque bearer token — never a DB id, never the QR's only content beyond
// this single string. Length bound only guards against abusive payloads;
// the real security property is the token's own entropy (see
// guest-order-service.ts) and the tokenHash equality lookup.
export const guestOrderTokenSchema = z.object({
  token: z.string().trim().min(32).max(200),
});
export type GuestOrderTokenInput = z.infer<typeof guestOrderTokenSchema>;

export const claimGuestOrderHandoffSchema = guestOrderTokenSchema.extend({
  tableId: z.string().uuid(),
});
export type ClaimGuestOrderHandoffInput = z.infer<typeof claimGuestOrderHandoffSchema>;
