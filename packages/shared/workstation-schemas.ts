import { z } from "zod";

// Printing V2 — DEPRECATED, samo za nazadnu kompatibilnost sa uparivanjem
// koje eksplicitno traži jednu rutu odmah (retko, testovi/legacy pozivi).
// Nova Admin ruta uparivanja OVO NIKAD ne šalje — uparivanje uspostavlja
// samo identitet računara; ruta štampe se bira POSLE, preko
// upsertPrintRoute (vidi printRouteTypeSchema/upsertPrintRouteSchema ispod).
export const workstationStationSchema = z.enum(["KITCHEN", "BAR"]);

export const createWorkstationPairingSchema = z.object({
  locationId: z.string().uuid(),
  // Opciono od Printing V2 nadalje — kad je prisutno, registerAgentFromPairing
  // odmah pred-kreira JEDNU odgovarajuću WorkstationPrintRoute (bez
  // štampača, "nije podešeno" dok se ne konfiguriše) radi nazadne
  // kompatibilnosti sa starijim pozivaocima; kad je izostavljeno (novi
  // Admin tok), uparivanje ne kreira nijednu rutu — sve rute se biraju
  // posle, u Admin panelu.
  station: workstationStationSchema.optional(),
  name: z.string().trim().min(1).max(100).optional(),
});
export type CreateWorkstationPairingInput = z.infer<typeof createWorkstationPairingSchema>;

// Printing V2 — tip rute štampe. Namerno ISTI skup vrednosti kao PrintJob.type
// (Prisma PrintJobType), UKLJUČUJUĆI RECEIPT — za razliku od
// workstationStationSchema iznad (KITCHEN|BAR), rute VEĆ podržavaju račun.
export const printRouteTypeSchema = z.enum(["KITCHEN", "BAR", "RECEIPT"]);
export type PrintRouteType = z.infer<typeof printRouteTypeSchema>;

// Admin bira štampač iz Workstation.availablePrinters (stvarno prijavljena
// lista te mašine) — server ovde NE validira da printerName pripada toj
// listi (agent ionako lokalno odbija štampu na neinstaliranom štampaču,
// isto pravilo kao configuredPrinterName ranije), samo oblik/dužinu.
export const upsertPrintRouteSchema = z.object({
  printerName: z.string().trim().min(1).max(200).nullable().optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).nullable().optional(),
  isEnabled: z.boolean().optional(),
  // PRINTING V2 FINAL — CENTRAL_ROUTING deterministic multi-agent routing.
  // Only meaningful once a location has more than one workstation with an
  // enabled route of the same type; harmless (never read) otherwise.
  isPrimary: z.boolean().optional(),
});
export type UpsertPrintRouteInput = z.infer<typeof upsertPrintRouteSchema>;

// PRINTING V2 FINAL — Admin's restaurant-level printing mode choice.
export const printingModeSchema = z.enum(["LOGIN_AWARE", "CENTRAL_ROUTING"]);
export const setPrintingModeSchema = z.object({ printingMode: printingModeSchema });
export type SetPrintingModeInput = z.infer<typeof setPrintingModeSchema>;

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding. The browser never
// asserts a workstationId or role here — a bind-intent is scoped to the
// authenticated employee's own session; the resulting one-time token is
// consumed only by whichever physical Agent process the OS itself routes a
// tablecore-print://bind?token=... URI to (see terminal-service.ts).
export const agentTerminalBindSchema = z.object({
  token: z.string().trim().min(16).max(200),
});
export type AgentTerminalBindInput = z.infer<typeof agentTerminalBindSchema>;

// Admin "Podešavanja" na već upareneoj radnoj stanici — namerno samo polja
// koja već postoje u Workstation modelu i koja Admin legitimno kontroliše
// (isto kao revokeWorkstation koji već piše isEnabled). Nikad stanica/
// lokacija/štampač ovde — to su izvedena/agent-prijavljena polja, ne nešto
// što admin ručno prepisuje.
export const updateWorkstationSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isEnabled: z.boolean().optional(),
});
export type UpdateWorkstationInput = z.infer<typeof updateWorkstationSchema>;

// Agent šalje SAMO kod — restaurantId/locationId/station se ISKLJUČIVO
// izvode iz uparivanja na serveru, agent ih nikad ne tvrdi direktno.
export const consumeWorkstationPairingSchema = z.object({
  code: z.string().trim().min(1).max(32),
  agentVersion: z.string().trim().min(1).max(50).optional(),
  osDescription: z.string().trim().min(1).max(200).optional(),
});
export type ConsumeWorkstationPairingInput = z.infer<typeof consumeWorkstationPairingSchema>;

// Printing V2 — jedan Agent sad može imati više ruta, svaka sa sopstvenom
// prijavljenom dostupnošću štampača (jedan boolean po Workstation-u više
// nije dovoljan). `type` mora odgovarati postojećoj WorkstationPrintRoute
// (server tiho ignoriše nepoznat tip — agent nikad ne kreira rute sam).
export const workstationHeartbeatRouteSchema = z.object({
  type: printRouteTypeSchema,
  printerAvailable: z.boolean(),
});

// PRINTING P0 — Service-side visibility probe. The Agent runs locally as
// NT SERVICE\TableCorePrintAgent (per-service virtual account) and
// enumerates printers under that identity — distinct from what the
// interactive Setup (logged-in user) sees. Per-user installs are the
// most common silent failure mode (paper comes out for "Test Print" from
// Setup, real orders fail because the Service cannot see the printer).
// The Agent probes on every heartbeat via the `visible` field on each
// route entry; the server persists the latest result per route so the
// Setup wizard can surface a human-friendly error before declaring READY.
// `visible` is OPTIONAL for backward compatibility with older agent
// builds that only knew about `printerAvailable` (the post-attempt
// result). New agent builds always send both. The route schema is
// defined inline here so the heartbeat schema below can reference it
// without circular-import gymnastics with workstation-service.ts.
export const workstationHeartbeatRouteV2Schema = workstationHeartbeatRouteSchema.extend({
  visible: z.boolean().nullable().optional(),
});
export type WorkstationHeartbeatRouteV2 = z.infer<typeof workstationHeartbeatRouteV2Schema>;

export const workstationHeartbeatSchema = z.object({
  agentVersion: z.string().trim().min(1).max(50).optional(),
  osDescription: z.string().trim().min(1).max(200).optional(),
  // DEPRECATED (Printing V2) — zadržano radi nazadne kompatibilnosti sa
  // starijim agent build-ovima koji još šalju jedan štampač/širinu umesto
  // `routes`. Novi agenti šalju `availablePrinters`/`routes` ispod.
  configuredPrinterName: z.string().trim().min(1).max(200).optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  // Faza 2B — agent lokalno proverava da li configuredPrinterName zaista
  // postoji u Windows spisku štampača pre svakog pokušaja štampe i
  // prijavljuje rezultat ovde; server NIKAD sam ne pretpostavlja dostupnost.
  printerAvailable: z.boolean().optional(),
  // Printing V2 — pun spisak Windows štampača (WindowsPrinter.Enumerate())
  // da bi Admin birao štampač iz stvarne liste te mašine.
  availablePrinters: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  // PRINTING V2 + P0 — po-ruti dostupnost konfigurisanog štampača te rute.
  // Accepts the v2 (extended with `visible`) shape so the server can
  // distinguish "Agent just confirmed this route's printer is visible to
  // the Service identity" (pre-attempt probe, written to
  // visibleToService) from "the last print attempt for this route
  // succeeded/failed" (post-attempt, written to printerAvailable).
  routes: z.array(workstationHeartbeatRouteV2Schema).max(10).optional(),
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

// PRINTING P0 — Setup wizard's HUMAN CONFIRMATION step. The Setup runs
// unauthenticated (the user has not yet bound an employee session to the
// freshly-paired Agent); the only actor it can prove is the workstation
// itself. The wizard's "Da, test tiket je uspešno odštampan" button POSTs
// here through the agent (which already authenticates via the Agent's
// bearer credential — not via an employee ctx), and the server marks the
// route physically-confirmed. Re-saving a route from Admin later resets
// this flag (workstation-service.upsertPrintRoute).
export const agentPhysicalConfirmationSchema = z.object({
  type: printRouteTypeSchema,
});
export type AgentPhysicalConfirmationInput = z.infer<typeof agentPhysicalConfirmationSchema>;

// PRINTING P0 — operator reconciliation surface for SUBMISSION_UNKNOWN
// PrintJob. The Agent poll query already filters status='PENDING', so
// a SUBMISSION_UNKNOWN job is structurally never auto-reclaimed by any
// future Agent poll. These two endpoints are the ONLY way out of that
// terminal state, both audited, both idempotent.
export const acknowledgePrintAmbiguitySchema = z.object({
  // What the operator saw at the printer:
  //   "PRINTED" = operator confirms the ticket did come out (status -> PRINTED)
  //   "REPRINT" = operator wants another physical copy (creates a NEW
  //               PrintJob row marked isReprint=true pointing here; the
  //               original stays SUBMISSION_UNKNOWN, audited)
  decision: z.enum(["PRINTED", "REPRINT"]),
  // PRINTING P0 — client-supplied idempotency key (UUID). The server treats
  // an identical (jobId, idempotencyKey) pair as the SAME operator action:
  // the first call performs the work and audits it, every subsequent call
  // with the same key returns the same record WITHOUT creating a new
  // PrintJob row, WITHOUT bumping the operator-decision timestamp, and
  // WITHOUT a duplicate audit entry. This is the ONLY thing standing
  // between an operator double-clicking "Pošalji ponovo" and two physical
  // tickets coming out of the printer — the UI disables the button after
  // the first click, but a slow network, a stuck modal, or a browser
  // re-submit can all re-fire the same click. Without idempotencyKey the
  // server creates a new PrintJob per click (current behaviour, verified
  // by tests/integration/printing-p0.test.ts "double-click protection").
  idempotencyKey: z.string().trim().min(8).max(64),
});
export type AcknowledgePrintAmbiguityInput = z.infer<typeof acknowledgePrintAmbiguitySchema>;
