import { z } from "zod";

// Regex alone accepts calendar-impossible values like "2026-02-30" — the
// native <input type="date"> the UI actually uses can never produce one,
// but a direct API call could, and Date.UTC() would silently NORMALIZE it
// forward (Feb 30 -> Mar 2) instead of rejecting it, which would book the
// wrong day with no error. The refine() below closes that gap by checking
// the parsed value round-trips to the exact same year/month/day.
const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum mora biti u obliku GGGG-MM-DD")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  }, "Datum ne postoji u kalendaru");
const hmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Vreme mora biti u obliku ČČ:MM");

const reservationCoreFields = {
  guestName: z.string().min(1, "Ime gosta je obavezno").max(120),
  phone: z.string().min(3, "Telefon je obavezan").max(40),
  date: ymdSchema,
  time: hmSchema,
  partySize: z.number().int().min(1, "Broj osoba mora biti bar 1").max(200),
  tableId: z.string().uuid().nullable().optional(),
  note: z.string().max(500).optional(),
};

export const createReservationSchema = z.object({ ...reservationCoreFields, locationId: z.string().uuid() });
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const updateReservationSchema = z.object({ ...reservationCoreFields });
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;

export const cancelReservationSchema = z.object({ reason: z.string().max(500).optional() });
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;

export const seatReservationSchema = z.object({ tableId: z.string().uuid().nullable().optional() });
export type SeatReservationInput = z.infer<typeof seatReservationSchema>;
