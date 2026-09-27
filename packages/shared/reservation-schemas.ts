import { z } from "zod";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum mora biti u obliku GGGG-MM-DD");
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
