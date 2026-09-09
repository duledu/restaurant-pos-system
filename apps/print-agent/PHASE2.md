# Phase 2 design only — not implemented

> **Historical design proposal, since implemented (Phase 2A/2B/2C) via a
> somewhat different, simpler path than proposed here**: HTTPS polling
> instead of WSS/SSE streaming, a bearer-credential + SHA-256-hash identity
> instead of a device key pair, and a Windows Service (proven to work,
> contrary to the caution in [COMPATIBILITY.md](COMPATIBILITY.md)) instead
> of a per-user logon task. Kept for the historical design rationale; for
> current behavior see [README.md](README.md) and
> [../../docs/print-agent-phase2c-report-2026-09-09.md](../../docs/print-agent-phase2c-report-2026-09-09.md).

## Station-level behavior and schema decision

No schema change is needed for Phase 1. An explicit persisted mode later requires an additive `PrintMode` enum (`PREVIEW`, `SILENT`) and `PrinterConfig.printMode`; existing autoPrint/type fields cannot faithfully express it. Reserve ASK_EVERY_TIME as a future enum extension, not a hidden frontend branch. Mode belongs to the existing location/station configuration and admin domain validation.

| Station | Primary/preferred mode | Automatic dispatch | Example |
| --- | --- | --- | --- |
| Kitchen | SILENT | true | POS-58, 58 mm |
| Bar | SILENT | true | EPSON, 80 mm |
| Receipt | PREVIEW by default; admin can choose SILENT | false by default | CASHIER_PRINTER, 80 mm |

Keep isEnabled as station availability, autoPrint as whether dispatch starts automatically, copies as explicit copy policy, paperWidthMm as the frozen rendering width and printerType as transport capability. The current KDS eligibility uses isEnabled rather than autoPrint; a later feature-gated rollout must reconcile that difference explicitly, preserving installed behavior until an admin activates the agent. Backfill modes conservatively to preserve current preview behavior; activate Kitchen/Bar SILENT and autoPrint through admin onboarding, not an unconditional migration. No kitchen user configures printers.

PREVIEW continues the existing receipt preview/browser workflow. SILENT can later route the same receipt snapshot to the agent. Do not silently switch waiter/cashier receipts to the agent or bypass preview. An offline agent in a SILENT Kitchen/Bar flow should produce a visible device fault, not an unexpected browser dialog in normal order flow. Explicit recovery can remain available to authorized staff.

## Registration and delivery

Admin → Devices / Printers issues a short-lived, single-use pairing code scoped to restaurant/location. The workstation generates its own key pair, registers with the pairing code, and stores a device credential/private key using Windows protected storage and restrictive account ACLs. No DATABASE_URL, AUTH_SECRET or server signing private key reaches the device. Device records include public key, location, workstation identity, capabilities, agent version, last heartbeat and revoked state.

Admin maps Kitchen/Bar/Receipt to registered workstation queues, paper widths, copies and modes. Local Windows queue names remain device-specific; PrinterConfig remains station policy. Show offline status, paper/driver capability diagnostics when available, last submission and **unknown** outcomes. Distinguish spool status from observed physical printing. Audit mapping and reprint changes.

Use an outbound authenticated WSS connection or SSE stream with HTTPS acknowledgements; choose based on hosting constraints and reconnect behavior. Server claims using the existing atomic service before delivery. Browser polling and QZ must be excluded from agent-owned station dispatch during an explicitly controlled rollout. The web user workflow stays unchanged, but delivery ownership is exclusive.

Server signs a canonical, versioned job envelope containing restaurant/location/device/station, PrintJob ID, claim generation, dispatch key, frozen payload hash, issued/expiry times and nonce. Agent verifies device/station scope, signature/key ID, expiry, schema and replay identity before accepting. Use short-lived transport credentials with revocation checks; close streams and stop new submissions when revoked. Unknown revocation state must not authorize new deliveries. Already spooled paper cannot be revoked.

## Durability and reconciliation

Use a protected local durable spool (for example SQLite) keyed by immutable job ID and authorized attempt identity. Persist acceptance before acknowledgement and persist pre-submit intent before calling Windows. Record spool job ID when using an API/controller that exposes it. Reconnect delivers acknowledgements from that ledger without printing again. Server acknowledgement is conditional on the current claim generation. Do not reinterpret the existing 90-second lease as proof that a job never printed.

A crash between Windows acceptance and local completion remains ambiguous. Reconcile with Windows spool state where possible and escalate unknown outcomes; never promise exactly-once physical output. Retry only provable pre-submission failures using bounded backoff. An intentional reprint continues to create a new audited PrintJob dispatch key. Cancellation/reprint never changes order/payment business data. Define dedupe retention, disk-full behavior and upgrade compatibility before rollout.

## Windows packaging and operations

Release requirement: **one codebase and one self-contained win-x64 installer for Windows 10 x64 and Windows 11 x64**. No Windows 11-only API or installer launch condition. Use the WindowsX64 publish profile and qualify the exact same artifact on both OSes, including clean machines without .NET. See [COMPATIBILITY.md](COMPATIBILITY.md) for OS servicing and runtime lifecycle constraints.

Microsoft's documented System.Drawing.Printing exclusion covers ASP.NET as well as Windows Services. The current in-process Kestrel/PrintDocument POC therefore needs a desktop print-worker separation or other supported hosting approach before production, on both OSes. A per-user logon task is the simpler auto-start choice; a service is not required for silent printing.

Initially prefer an auto-start per-user workstation process because installed printer visibility and GDI printing are session/account-sensitive. If a Windows service is required, validate the rendering API's service-host support and printer access separately; a service broker plus an interactive-session print worker may be appropriate. Do not simply host this POC inside IIS or convert it to a service without those checks. Add restart policy, health heartbeat, structured rotating logs, redaction, crash diagnostics and bounded driver-worker isolation.

Provide an MSI or EXE installer that provisions restrictive application/data ACLs, registers auto-start, performs admin-only pairing/queue tests, and supports repair/uninstall. Sign EXE, DLLs and installer with an organization Authenticode certificate and trusted timestamp; keep signing keys in a protected build/signing service. Windows executable signing is distinct from server job signing and HTTPS certificates. No QZ certificate or QZ security setting is reused.

Updates use HTTPS plus signed version manifests, artifact hashes, Authenticode verification and anti-rollback policy, staged rollout, rollback/recovery and safe draining of in-flight submissions. Rotate job verification keys with overlapping key IDs; rotate device credentials independently. Admin revocation disables device credentials immediately. Preserve the durable spool during updates. All migration, production registration, distribution and deployment require a separate reviewed phase.
