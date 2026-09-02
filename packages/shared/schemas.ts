import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Korisničko ime je obavezno"),
  password: z.string().min(1, "Lozinka je obavezna"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const pinLoginSchema = z.object({
  // Opciono — kada UI zna tačnog zaposlenog unapred (npr. postojeći
  // testovi/integracije). Touch PIN tastatura (Deljeni POS/Lični uređaj)
  // NIKAD ne šalje employeeId — namerno, da izbegne listu zaposlenih pre
  // PIN-a (nema "employee enumeration"). Kada nije poslat, employee se
  // pronalazi proverom PIN-a naspram svih aktivnih zaposlenih uređaja (vidi
  // pin-login/route.ts) — bezbedno jer je PIN jedinstven po restoranu
  // (Staff Management, packages/domain/employees/employee-service.ts).
  employeeId: z.string().uuid().optional(),
  pin: z
    .string()
    .regex(/^\d{4,6}$/, "PIN mora imati 4-6 cifara"),
  deviceId: z.string().uuid(),
});
export type PinLoginInput = z.infer<typeof pinLoginSchema>;

export const registerDeviceSchema = z.object({
  locationId: z.string().uuid(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const renameDeviceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type RenameDeviceInput = z.infer<typeof renameDeviceSchema>;

export const setDeviceStatusSchema = z.object({
  isActive: z.boolean(),
});
export type SetDeviceStatusInput = z.infer<typeof setDeviceStatusSchema>;

export const createEmployeeSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().optional(),
  password: z.string().min(10).optional(),
  pin: z
    .string()
    .regex(/^\d{4,6}$/)
    .optional(),
  roleNames: z.array(z.string().min(1)).min(1, "Bar jedna rola je obavezna"),
  locationIds: z.array(z.string().uuid()).min(1, "Bar jedna lokacija je obavezna"),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  roleNames: z.array(z.string().min(1)).min(1, "Bar jedna rola je obavezna").optional(),
  locationIds: z.array(z.string().uuid()).min(1, "Bar jedna lokacija je obavezna").optional(),
  pinLoginEnabled: z.boolean().optional(),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const resetPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN mora imati 4-6 cifara"),
});
export type ResetPinInput = z.infer<typeof resetPinSchema>;

export const setEmployeeStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});
export type SetEmployeeStatusInput = z.infer<typeof setEmployeeStatusSchema>;
