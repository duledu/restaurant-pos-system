import { z } from "zod";

// Radna stanica u ovoj fazi štampa isključivo kuhinjske/šank tikete (nikad
// račun) — namerno uže od PrinterConfig.station (koje dozvoljava i RECEIPT).
export const workstationStationSchema = z.enum(["KITCHEN", "BAR"]);

export const createWorkstationPairingSchema = z.object({
  locationId: z.string().uuid(),
  station: workstationStationSchema,
  name: z.string().trim().min(1).max(100).optional(),
});
export type CreateWorkstationPairingInput = z.infer<typeof createWorkstationPairingSchema>;

// Agent šalje SAMO kod — restaurantId/locationId/station se ISKLJUČIVO
// izvode iz uparivanja na serveru, agent ih nikad ne tvrdi direktno.
export const consumeWorkstationPairingSchema = z.object({
  code: z.string().trim().min(1).max(32),
  agentVersion: z.string().trim().min(1).max(50).optional(),
  osDescription: z.string().trim().min(1).max(200).optional(),
});
export type ConsumeWorkstationPairingInput = z.infer<typeof consumeWorkstationPairingSchema>;

export const workstationHeartbeatSchema = z.object({
  agentVersion: z.string().trim().min(1).max(50).optional(),
  osDescription: z.string().trim().min(1).max(200).optional(),
  configuredPrinterName: z.string().trim().min(1).max(200).optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  // Faza 2B — agent lokalno proverava da li configuredPrinterName zaista
  // postoji u Windows spisku štampača pre svakog pokušaja štampe i
  // prijavljuje rezultat ovde; server NIKAD sam ne pretpostavlja dostupnost.
  printerAvailable: z.boolean().optional(),
});
export type WorkstationHeartbeatInput = z.infer<typeof workstationHeartbeatSchema>;

// Faza 2B — isporuka. Namerno BEZ jobId/attemptId u telu (poll ne prima
// ništa — server bira SLEDEĆI red isključivo iz autentifikovanog
// identiteta radne stanice).
const uuidLike = z.string().uuid();

export const agentSubmissionStartSchema = z.object({
  attemptId: uuidLike,
});
export type AgentSubmissionStartInput = z.infer<typeof agentSubmissionStartSchema>;

export const agentPrintResultSchema = z.object({
  attemptId: uuidLike,
  outcome: z.enum(["SUBMITTED_TO_SPOOLER", "FAILED_BEFORE_SUBMISSION", "SUBMISSION_UNKNOWN"]),
  errorMessage: z.string().trim().max(500).optional(),
});
export type AgentPrintResultInput = z.infer<typeof agentPrintResultSchema>;

// Faza 2C — Admin "Test Print" dugme. Namerno BEZ jobId/attemptId (test
// štampa nikad ne postaje PrintJob red — vidi schema.prisma Workstation
// testPrintStatus napomenu). Agent prijavljuje ishod SVOJE lokalno
// izvedene testne štampe (WindowsPrinter.Print preko Ticket.TestPrint),
// server samo ažurira prikazan status, ne autoritativan izvor ishoda.
export const agentTestPrintResultSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED"]),
  errorMessage: z.string().trim().max(500).optional(),
});
export type AgentTestPrintResultInput = z.infer<typeof agentTestPrintResultSchema>;
