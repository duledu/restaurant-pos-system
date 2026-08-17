import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Neispravna email adresa"),
  password: z.string().min(1, "Lozinka je obavezna"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const pinLoginSchema = z.object({
  employeeId: z.string().uuid(),
  pin: z
    .string()
    .regex(/^\d{4,6}$/, "PIN mora imati 4-6 cifara"),
  deviceId: z.string().uuid(),
});
export type PinLoginInput = z.infer<typeof pinLoginSchema>;

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
