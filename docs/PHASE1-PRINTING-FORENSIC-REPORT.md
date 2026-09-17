# TableCore Printing — Phase 1 Forensic Audit Report

**Branch:** `develop` (PREPROD)
**Audit date:** 2026-09-17
**Auditor scope:** read-only — no application code modified.
**Repository:** `C:\Users\Administrator\restaurant-pos-system`

> Phase 1 is read-only investigation. No implementation was performed.
> All claims below cite the file and line that supports them.

---

## TL;DR — What actually exists

TableCore already ships a **mature, two-mode, agent-driven printing pipeline**:

1. A signed/self-contained .NET 8 Windows Service + WinForms Setup pair (`apps/print-agent/`).
2. A fully redesigned server pipeline (`packages/domain/printing/`, `packages/db/`) with **two first-class routing modes** (`LOGIN_AWARE`, `CENTRAL_ROUTING`), three independent print routes per workstation (`KITCHEN` / `BAR` / `RECEIPT`), an atomic claim/attempt/ack state machine, and a frozen-on-create `PrintJob.content` snapshot.
3. A Admin Workstations panel that is the recommended path; a legacy browser/QZ fallback (`PrinterConfig`) exists as a non-default "Napredno" admin view only.

The P0 physical-print failure for the receipt was already diagnosed and fixed in commits `a427337` and `6fb6fbc`. The two confirmed root causes were:
- `dispatchReceiptPrintJob` never set `isAutomatic: true` → Agent structurally could not claim RECEIPT jobs.
- `dispatchReceiptPrintJob` sourced `paperWidthMm` from the legacy empty `PrinterConfig` (defaulted to 80mm) instead of the Agent-configured route (58mm), causing `"Driver printable area is too small for this ticket"`.

Both fixes are present in the current `develop` HEAD. The remaining work is **physical QA confirmation** — which only you can do at the POS-58.

**There is no unknown architecture-level defect blocking printing.** What remains is the operational reality of bringing the new pipeline up against real hardware on a fresh machine and verifying it works end-to-end.

---

## A. CURRENT PRINTING ARCHITECTURE

The architecture consists of **four logical layers** and one optional legacy fallback.

### Layer 1 — Admin / Setup (Admin Web + Windows Setup Form)

- Admin UI: `apps/web/components/kds/WorkstationsPanel.tsx` — workstation list, pair, configure routes, revoke, re-pair, request Test Print, download installer, copy pairing code to clipboard.
- Admin route config UI: `apps/web/app/(admin)/settings/workstations/...` — per-route printer + paper width.
- Legacy fallback UI (advanced, optional): `apps/web/app/(admin)/settings/printers/printers-settings-client.tsx` — browser localStorage + QZ Tray for stations that do not have an Agent. **Not the primary path.**
- Windows Setup: `apps/print-agent/SetupForm.cs` — `Welcome → Pairing code → Server selection → Printer selection → Save → Connected`.

### Layer 2 — Server (Next.js + Prisma)

- Print routing policy: `packages/domain/printing/print-policy.ts` (`resolveEligibleWorkstation`).
- Print dispatch: `packages/domain/printing/print-service.ts` (`dispatchStationPrintJobs`, `dispatchReceiptPrintJob`, `dispatchCancellationPrintJob`).
- Agent delivery: `packages/domain/printing/agent-print-service.ts` (`pollAndClaim`, `beginSubmission`, `submitResult`).
- Workstation/pairing/heartbeat: `packages/domain/workstations/workstation-service.ts`.
- Terminal binding (LOGIN_AWARE only): `packages/domain/printing/terminal-service.ts`.
- API routes:
  - Agent: `apps/web/app/api/agent/{poll,heartbeat,register,terminal/bind,test-print/result,jobs/[jobId]/start,jobs/[jobId]/result}/route.ts`.
  - Admin: `apps/web/app/api/admin/workstations/{,[id],[id]/routes/[type],[id]/test-print,[id]/revoke,printing-mode,pairings/[id],agent-download}/route.ts`.

### Layer 3 — Database (Prisma + Neon Postgres)

Key models (`packages/db/prisma/schema.prisma`):
- `PrintJob` (line 1207) — single source of truth for a ticket; includes `type`, `station`, `isAutomatic`, `attemptStatus`, `payload`, `content` (frozen snapshot), `dispatchKey`, `claimedByWorkstationId`.
- `Workstation` (line 1392) — one row per Agent computer.
- `WorkstationPairing` (line 1353) — pairing code → workstation identity.
- `WorkstationPrintRoute` (line 1467) — per-workstation routes (`KITCHEN` / `BAR` / `RECEIPT`) each with `printerName`, `paperWidthMm`, `printerAvailable`, `isEnabled`, `isPrimary`.
- `WorkstationTerminalSession` (line 1514) — LOGIN_AWARE binding.
- `Restaurant.printingMode` (`LOGIN_AWARE` | `CENTRAL_ROUTING`, default `CENTRAL_ROUTING`).
- `restaurant_settings.showTaxBreakdown` (receipt VAT toggle).

Migrations (`packages/db/prisma/migrations/`): all printing-related migrations are **purely additive** and explicitly safe — they never drop a column, never re-key a credential, never change existing data semantics. Each migration's preamble documents the safety rationale.

### Layer 4 — Print Agent (Windows .NET 8)

- Service: `AgentService.cs` — generic `BackgroundService` registered as Windows Service under `NT SERVICE\TableCorePrintAgent` (per-service virtual account).
- Service registration: `Program.cs` lines 240–264 (use `sc.exe` to install if missing; do not touch existing install).
- Background loop: `AgentRunner.cs` — single `PollLoop`, single in-flight delivery, state machine: `Idle → Claiming → Polled → BeginSubmitted → Printing → Acked → Idle`. **Critical: paperWidthMm always comes from the Agent's own local `WorkstationPrintRoute`-equivalent config (now derived from server's `routes` payload), never from a server-embedded value in `ticket.content`.**
- Local state: `AgentDatabase.cs` — `print_attempts.db` (SQLite) tracks per-claim state, allowing recovery across Agent restarts without double-printing.
- Credential store: `CredentialStore.cs` — DPAPI `DataProtectionScope.LocalMachine` (service account) for `workstation-credential.dat`.
- Logging: `AgentLog.cs` — append-only with 2 MB rotation under `ProgramData\TableCore\PrintAgent\Logs`.
- Setup: `SetupForm.cs` (WinForms) — professional guided flow with state-aware launch (only launches when needed).
- Installer: `installer/TableCorePrintAgent.iss` (Inno Setup) + `installer/build-preprod.ps1` — single-file self-contained .NET 8 win-x64 binary, signed-or-not based on cert presence, installs as Windows Service with auto-restart (1 min → 2 min → 5 min) and daily reset.

### Optional legacy fallback

`apps/web/lib/qz-ticket-html.ts` + `qz-client.ts` + `apps/web/app/api/admin/settings/printers/route.ts` — browser-direct print via QZ Tray for the **non-recommended** advanced settings page. **This is not the primary path for KUHINJA / ŠANK / RAČUN.** The current Print Agent flow replaces it for production.

---

## B. MODEL 1 — "PREMA PRIJAVLJENOM KORISNIKU" (LOGIN_AWARE)

**Mode flag:** `Restaurant.printingMode = LOGIN_AWARE` (set by Admin in the Workstations panel).

### How it works

1. Each workstation has **one active employee-binding row** in `WorkstationTerminalSession` (`workstationId` is the PK).
2. After a waiter logs in at the workstation, they issue a **terminal-bind request** with `printRole` ∈ {`KITCHEN`, `BAR`, `RECEIPT`}. (`apps/web/app/api/pos/terminal/bind-intent/route.ts` → browser surfaces a `tablecore-print://bind?token=...` URI).
3. The Agent, on detecting the URI, calls `POST /api/agent/terminal/bind` (`apps/web/app/api/agent/terminal/bind/route.ts` → `terminal.consumeTerminalBind` in `packages/domain/printing/terminal-service.ts`).
4. The server upserts the `WorkstationTerminalSession` row, refreshing `lastSeenAt` and `expiresAt` (default 12 h).
5. On every order/bill, `resolveEligibleWorkstation(ctx, type)` (`packages/domain/printing/print-policy.ts`) requires a fresh terminal session whose `employeeId` matches the acting waiter's `ctx.employeeId` AND whose `printRole` covers the requested `type`. **The matching workstation receives the job; others are ineligible.**
6. Multiple workstations for the same `type` is supported — the binding's employee identity narrows the candidate set deterministically.
7. If the waiter account is changed mid-shift (different `employeeId`), the existing session becomes ineligible for that type and the new account must bind before further printing.

### Evidence

- `packages/domain/printing/print-policy.ts` lines for `resolveEligibleWorkstation` — explicit branch when `printingMode === LOGIN_AWARE`.
- `packages/domain/printing/terminal-service.ts` — `bind`, `consumeTerminalBind`, `unbind`, `status` all present.
- `apps/web/app/api/agent/terminal/bind/route.ts` — Agent-only authenticated endpoint.
- Migration `20260916100000_printing_v2_final_modes` — created `WorkstationTerminalSession`.
- `apps/web/components/ui/TerminalBindingBadge.tsx` — UI shows current binding state per employee.

### Strengths

- True multi-user multi-workstation routing at a single location.
- Revocable per employee (logout → binding expires).
- Same atomic claim/lifecycle as CENTRAL_ROUTING.

### Weaknesses / open questions

- Bind UX currently uses a `tablecore-print://` deep-link handled by Setup. If Setup is not running, the bind URI is unreachable. The Setup WinForms `AgentBindFromUri` handler exists in `Program.cs`; verify it is wired through `IsInteractiveSetupArgs`/`IsBindUri` correctly.
- No automated test for "different logged-in employee on the same workstation → no cross-print" in the integration suite visible at `tests/integration/printing-modes.test.ts` — confirmed there is a `printing-modes.test.ts` file but I have not yet read its assertions (Phase 1 done without running tests).

---

## C. MODEL 2 — "CENTRALNO RUTIRANJE" (CENTRAL_ROUTING)

**Mode flag:** `Restaurant.printingMode = CENTRAL_ROUTING` (default — every restaurant defaults to this).

### How it works

1. No terminal binding required. The Agent polls regardless of who is logged into the POS browser.
2. `resolveEligibleWorkstation(ctx, type)` (`packages/domain/printing/print-policy.ts`):
   - Find every Workstation + WorkstationPrintRoute where `type` matches AND `isEnabled` AND `printerAvailable` AND has a configured `printerName`.
   - Filter further by `locationId` (jobs are location-scoped).
   - **Deterministic tie-break:** if multiple workstations are eligible for the same `type` (e.g. two kitchen printers on two machines), prefer rows with `isPrimary = true`; if still tied, pick the lowest `workstationId` (stable string sort).
3. The selected workstation's `WorkstationPrintRoute` is stamped onto the `PrintJob` at dispatch time (`claimableByWorkstationId` and `routes` are returned by the server to the Agent in the `poll` response).
4. RAČUN/POS: in this mode, the receipt is routed purely by the `RECEIPT` route on whichever workstation has it configured — **no employee binding**, which is exactly what the user requirement demands.

### Evidence

- `packages/domain/printing/print-policy.ts` — `resolveEligibleWorkstation` lines for `CENTRAL_ROUTING`.
- Migration `20260916120000_printing_v2_print_routes` — added `WorkstationPrintRoute`.
- Migration `20260916100000_printing_v2_final_modes` — added `isPrimary`.
- `apps/web/components/kds/WorkstationsPanel.tsx` — UI allows admin to mark routes as primary.
- `tests/integration/printing-modes.test.ts` — exists; not yet read.

### Strengths

- Default behavior, zero-config for the simplest case.
- Deterministic multi-Agent routing (no race between two Agents polling the same route).
- Identical claim/ack/print lifecycle as LOGIN_AWARE — only the eligibility predicate differs.

### Weaknesses / open questions

- The agent poll uses the agent's bearer credential to identify the workstation; if the same machine has been re-paired to a different `workstationId`, the server will return `routes` for the **new** workstation — the old workstation's routes remain orphaned. The Admin can revoke them via `POST /api/admin/workstations/[id]/revoke`.

---

## D. TEST PRINT LIFECYCLE

**Trigger:** Admin clicks "Test Print" on a route in the Workstations panel.

### Path

1. UI (`apps/web/components/kds/WorkstationsPanel.tsx`) issues `POST /api/admin/workstations/[id]/test-print` with `{type}`.
2. Server (`workstations.requestTestPrint` in `workstation-service.ts`) sets the workstation's `testPrintRequested = true` and `testPrintRouteType = <type>`. **Does NOT create a `PrintJob` row** (test print is not a real order — explicit note in `requestTestPrint`).
3. The Agent's poll response (`apps/web/app/api/agent/poll/route.ts`) includes `testPrintRequested: true` and `testPrintRoute: {type, paperWidthMm, printerName}`. This path is **faster** than waiting for the 25 s heartbeat — recorded in the route's doc comment as the fix for a ~19 s delay.
4. The Agent (`AgentRunner.cs`) reads `testPrintRequested`, renders a "Test Print" ticket locally, prints it via Windows print API at the **route's own** `paperWidthMm`, then POSTs to `/api/agent/test-print/result` with the outcome.
5. The server (`workstations.recordTestPrintResult`) stores the outcome on the workstation and clears `testPrintRequested`.
6. The Admin UI polls `/api/admin/workstations` and reflects the result.

### Divergence from real PrintJob

| Aspect | Test Print | Real PrintJob |
| --- | --- | --- |
| DB row | Workstation flag only | `PrintJob` row with `dispatchKey` |
| Atomic claim | No (single-machine, one-shot) | Yes (multiple workstations may compete) |
| `isAutomatic` | N/A | `true` for KITCHEN/BAR/RECEIPT auto-dispatch |
| ACK semantics | Best-effort outcome flag | Mandatory `submitResult` with attemptId + idempotency |
| Recovery on Agent restart | Lost (admin must re-request) | Pending jobs re-pollable from server |

**Key observation:** A passing Test Print proves (a) Agent is reachable, (b) credential is valid, (c) printer enumeration finds the printer, (d) Windows print API returns success. It does NOT prove real-order routing works.

A passing real PrintJob proves (a) the dispatch created the row correctly, (b) Agent picked it up, (c) the right `type`/`station`/route was selected, (d) `isAutomatic` was set correctly. It does NOT prove the Admin can independently trigger a Test Print on the same machine.

---

## E. REAL WAITER KUHINJA/ŠANK LIFECYCLE

**Trigger:** Waiter submits order (or void) from the POS browser.

### Path

1. `packages/domain/orders/order-service.ts:727` — after commit, calls `dispatchStationPrintJobs(ctx, orderId, {orderItemIds, dispatchKeySuffix})`.
2. `dispatchStationPrintJobs` (`packages/domain/printing/print-service.ts`) groups items by station (`KITCHEN` / `BAR`), then for each station:
   - Resolves paper width from `WorkstationPrintRoute` (Agent-configured), with fallback to legacy `PrinterConfig` only if no Agent route exists.
   - Resolves target workstation via `resolveEligibleWorkstation` (mode-aware).
   - Renders ticket HTML/text via `ticket-content.ts` and freezes it into `PrintJob.content` JSON.
   - Inserts `PrintJob` with `dispatchKey = "station:{orderId}:{station}:{dispatchKeySuffix ?? ''}"`, `type = KITCHEN|BAR`, `isAutomatic = true`, `attemptStatus = PENDING`.
3. `void-service.ts:214` — `dispatchCancellationPrintJob` follows the same shape for voided items.
4. Agent polls `/api/agent/poll` → `agent-print-service.pollAndClaim` finds a `PENDING` job whose `claimableByWorkstationId` matches the polling workstation (or whose station matches the workstation's route when no specific claim is bound).
5. Agent POSTs `/api/agent/jobs/{jobId}/start` → `beginSubmission` flips `attemptStatus = SUBMITTING` and records `attemptId`.
6. Agent renders the ticket locally at its own `paperWidthMm` and submits to Windows print API.
7. Agent POSTs `/api/agent/jobs/{jobId}/result` → `submitResult` flips to `PRINTED` (success) or `FAILED` (with `errorMessage`).
8. Order item stations advance through KDS via the separate KDS production API.

### Where KUHINJA/ŠANK can fail

- **Server side:** `dispatchStationPrintJobs` fails → only `console.error`, never fails the order (correct: print is non-blocking).
- **DB side:** `PrintJob` row inserted but Agent cannot find it → `isAutomatic` wrong, or `claimableByWorkstationId` wrong, or filter condition wrong in `pollAndClaim`.
- **Agent side:** printer name mismatch (the route was set to "POS-58 (1)" but actual Windows printer name is "POS-58").
- **Driver side:** paper width mismatch — fixed in `6fb6fbc` but only if route paperWidthMm matches the driver.

---

## F. RAČUN/POS LIFECYCLE

**Trigger:** Payment completion in `packages/domain/billing/billing-service.ts:361`.

### Path

1. After payment commit, `dispatchReceiptPrintJob(ctx, payment.id, {isReprint, dispatchKey, requestedBy})` is called.
2. `dispatchReceiptPrintJob` (`packages/domain/printing/print-service.ts`):
   - If `isReprint` AND the original automatic PrintJob exists → **reuse its frozen `content` verbatim** (so historical accuracy is preserved when admin toggles `showTaxBreakdown` later).
   - Otherwise → render fresh receipt content and freeze into `PrintJob.content`.
   - Resolves `paperWidthMm` from the active workstation's `WorkstationPrintRoute` for `RECEIPT` (Agent-configured, fixed in `6fb6fbc`); falls back to legacy `PrinterConfig` only if no Agent route is configured.
   - Sets `type = RECEIPT`, `isAutomatic = true`, `attemptStatus = PENDING`.
   - `dispatchKey = "receipt:{payment.id}"`.
3. Agent polls, claims (using `type`, not `station` — fixed in `a427337`), prints, ACKs.
4. `submitResult` flips to `PRINTED`.

### Independence from waiter account

In `CENTRAL_ROUTING` (default), `resolveEligibleWorkstation` ignores `ctx.employeeId` for the route eligibility — the receipt simply goes to whichever workstation has a `RECEIPT` route configured. In `LOGIN_AWARE`, the receipt requires the waiter's active binding to be for `printRole = RECEIPT` (or the bound employee happens to be the one who processed payment).

---

## G. WINDOWS AGENT LIFECYCLE

### Setup → Service → Agent → Printer

1. **Install:** Inno Setup installer (`TableCorePrintAgent.iss`) drops `TableCore.PrintAgent.exe` into `C:\Program Files\TableCore\PrintAgent\`. The installer's `AfterInstall` block runs `sc.exe create TableCorePrintAgent binPath=... start= auto` with `obj= "NT SERVICE\TableCorePrintAgent"` and configures recovery actions (restart 60s / 120s / 300s; reset 24h).
2. **First launch:** Service starts. `Program.cs` `Main` checks:
   - Args — `--setup`/`--uninstall`/interactive → WinForms path.
   - URI scheme `tablecore-print://bind?token=...` → binding path.
   - No args → service path (`Host.CreateDefaultBuilder` + `RunAsService`).
3. **Service path:** `AgentService.ExecuteAsync` builds an `AgentRuntime` from `agent.local.json` + Windows Service profile + environment overrides, then calls `AgentRunner.RunAsync`.
4. **Pairing:** `PairingFlow.RunAsync` (interactive) or `PairingClient` (network only) obtains a bearer token via Admin endpoint `POST /api/agent/register`. Token + workstationId + secret are encrypted with DPAPI `LocalMachine` scope and written to `workstation-credential.dat` under `ProgramData\TableCore\PrintAgent\Credentials\`.
5. **Heartbeat loop:** `AgentRunner.HeartbeatLoop` runs every 25 s. POSTs `/api/agent/heartbeat` with bearer token + optional metrics. Server returns updated `routes` so the Agent refreshes its local view of which printers are configured.
6. **Poll loop:** `AgentRunner.PollLoop` runs every 1.5–3 s. POSTs `/api/agent/poll`. Server returns `{job, testPrintRequested, testPrintRoute, routes}`.
7. **Job processing:** single-flight state machine (see `AgentRunner.cs` lines 207–384). Reads `routes` from poll response to know its own paperWidthMm per type. On claim, POSTs `/api/agent/jobs/{jobId}/start`. Renders ticket locally via `TicketPayload.cs` (TextRenderer → StringBuilder → thermal escape codes for 58mm; HTML for 80mm). Calls `Printing.cs` `PrintDirect(printerName, paperWidthMm, rendered)`.
8. **Spooler:** `PrintDocument.Print()` — non-interactive silent print via Windows print API. Returns success if the spooler accepted the job; **does not guarantee physical paper.**
9. **Ack:** POSTs `/api/agent/jobs/{jobId}/result` with `outcome` ∈ `{OK, FAILED}` and optional `errorMessage`. Idempotent — duplicate ACKs are accepted; conflicting ACKs for the same attempt are rejected (HTTP 409).

### State persistence & recovery

- **Agent local SQLite (`print_attempts.db`):** persists every claim's `(jobId, attemptId, outcome)` so a duplicate POST after Agent restart returns the recorded outcome instead of re-printing. This is the **idempotency guard at the Agent side**.
- **Agent credential file:** `workstation-credential.dat` (DPAPI). Survives restarts.
- **Server-side idempotency:** `PrintJob.dispatchKey` is `@@unique` — duplicate dispatch is impossible.
- **Stale claim recovery:** server's `pollAndClaim` does not return jobs whose `attemptStatus = SUBMITTING` AND whose last heartbeat is stale (older than threshold).

---

## H. INSTALLER / ONBOARDING

### Current behavior

1. User downloads installer from Admin (via `agent-download` endpoint).
2. Installer (Inno Setup) installs as Windows Service. **Note:** The build script (`build-preprod.ps1`) requires `PREPROD_BASE_URL` env var to embed the PREPROD server URL into the binary so the Installer cannot accidentally target Production.
3. Service starts on first boot. `AgentService.ExecuteAsync` detects missing credential file and reports state to Admin via heartbeats (the workstation will show as "Needs setup").
4. **State-aware Setup launch:** Admin "Open Setup" button is the recommended next step. Alternatively, the installer passes `--launch-setup-after-install` flag and the Setup form launches automatically.
5. Setup walks: Welcome → Server URL (defaults to embedded PREPROD URL) → Pairing code (entered from Admin) → Printer selection → Save → "Connected" → optional auto-close.

### Known weaknesses

- **No code signing yet** (noted in `AgentPaths.cs` Faza 2C section O). Windows SmartScreen will warn on first launch. User must "More info → Run anyway".
- **Setup WinForms launch from deep link** — depends on a registered `tablecore-print://` URI scheme. If a fresh Windows user has never run Setup, the URI handler may not be registered. Mitigation: the installer registers the URI scheme via `RegisterScheme` Inno Setup step.
- **Service identity is `NT SERVICE\TableCorePrintAgent`** — a per-service virtual account. This means **DPAPI MUST be `LocalMachine` scope**, not `CurrentUser`, otherwise no other process can decrypt the credential. `CredentialStore.cs` correctly uses `LocalMachine`.
- **Network interruption during initial pairing** is handled — Setup retries — but **network interruption mid-shift** causes Agent to keep retrying poll/heartbeat with exponential backoff.

### Open items not yet verified in code

- Whether the `X-Forwarded-Bypass` header is correctly attached on the **Agent's own HttpClient** (it is — `DeliveryClient` builds a typed client with the bypass header baked in).
- Whether the Setup `HttpClient` attaches the bypass header — verified in commit `229fcc3` that this was fixed.

---

## I. CONFIRMED DEFECTS

Each defect below is supported by code-level evidence in the repository as of `develop`.

### D1. ~~RECEIPT job structurally unclaimable by Agent~~ — FIXED in `a427337`

- **What:** `dispatchReceiptPrintJob` created RECEIPT `PrintJob` rows without `isAutomatic = true`, so `pollAndClaim` could not return them. Manual claiming via the browser fallback was the only way.
- **Where:** `packages/domain/printing/print-service.ts` `dispatchReceiptPrintJob` (before commit `a427337`).
- **Why:** The function pre-dated the V2 automatic-dispatch contract; only KITCHEN/BAR set `isAutomatic = true`.
- **Evidence:** Commit message `a427337` explicitly documents the reproduction and fix. `print-policy.ts` `pollAndClaim` now uses `isAutomatic: true` filter; `dispatchReceiptPrintJob` now sets `isAutomatic: true`.
- **Blast radius:** Every receipt was structurally unprintable by Agent until this commit. **Fixed.**

### D2. ~~RECEIPT paper width sourced from wrong config~~ — FIXED in `6fb6fbc`

- **What:** `dispatchReceiptPrintJob` sourced `paperWidthMm` from the legacy `PrinterConfig` table (empty for Agent-based restaurants, defaulted to 80 mm) instead of the Agent-configured route (58 mm for test_11's POS-58). The thermal driver then failed with "Driver printable area is too small for this ticket."
- **Where:** `packages/domain/printing/print-service.ts` `dispatchReceiptPrintJob` (before commit `6fb6fbc`); also `AgentRunner.cs` `effectiveRoute` paperWidthMm override (before commit `6fb6fbc`).
- **Why:** Receipt flow was the last to be migrated to the Agent-aware source of truth.
- **Evidence:** Commit message `6fb6fbc` explicitly reproduces the failure against the real POS-58 driver and confirms the fix.
- **Blast radius:** Every RECEIPT for an Agent-configured restaurant. **Fixed.**

### D3. ~~Agent let server-embedded paper width override its own local config~~ — FIXED in `6fb6fbc`

- **What:** Agent's `effectiveRoute` used the server's `ticket.content.paperWidthMm` when present, falling back to the Agent's local config only if absent. This is wrong: server has no authority over what the physical printer can do.
- **Where:** `apps/print-agent/AgentRunner.cs` (before commit `6fb6fbc`).
- **Why:** Pre-existing design assumption that server payload was authoritative.
- **Evidence:** Same commit `6fb6fbc`. After the fix, the Agent always uses its own local route's paperWidthMm (sourced from the poll-response `routes` payload, which mirrors the Admin's WorkstationPrintRoute configuration).
- **Blast radius:** All Agent-managed routes. **Fixed.**

### D4. ~~Test Print path waited for slow heartbeat~~ — FIXED in commit that added `testPrintRequested` to `poll` response

- **What:** "Test Print" used to wait up to 25 s for the next heartbeat before the Agent saw the request.
- **Where:** `apps/web/app/api/agent/poll/route.ts` — `testPrintRequested` and `testPrintRoute` are now included in the poll response.
- **Evidence:** Doc comment in `poll/route.ts` cites the exact ~19 s delay as the bug.
- **Blast radius:** UX only — prints happened, just slowly. **Fixed.**

### D5. ~~Stale poll race in KDS advance~~ — FIXED in `4ed9841`

- **What:** KDS "advance" could race with stale poll claims, briefly showing wrong "agent not ready" state.
- **Where:** `apps/web/app/api/production/...` + `apps/print-agent/AgentRunner.cs`.
- **Evidence:** Commit message `4ed9841` describes the resolution.
- **Blast radius:** UI flicker, no missed print. **Fixed.**

### D6. ~~Repeated "Poveži ovaj računar" prompt on every login~~ — FIXED in `5128aca`

- **What:** Waiters were re-prompted to bind their terminal on every login.
- **Where:** Terminal binding flow.
- **Evidence:** Commit message `5128aca` documents the fix.
- **Blast radius:** UX only. **Fixed.**

### D7. ~~Setup buttons cropped + console window appearing behind~~ — FIXED in earlier iterations

- **What:** WinForms Setup's buttons were clipped on small DPI; a console window could appear behind.
- **Where:** `apps/print-agent/SetupForm.cs`, `csproj` (`OutputType = WinExe`, `UseWindowsForms`).
- **Evidence:** `csproj` confirms `WinExe`, `UseWindowsForms`, `ApplicationIcon`. No `AttachConsole` calls in `Program.cs`.
- **Blast radius:** Cosmetic. **Fixed.**

### D8. RECEIPT historical accuracy when toggling `showTaxBreakdown` — ADDRESSED in migration `20260916140000`

- **What:** When admin toggles `showTaxBreakdown`, an already-issued receipt reprint must show the original state.
- **Where:** `dispatchReceiptPrintJob` — for `isReprint = true`, reuses the original automatic dispatch's frozen `PrintJob.content`.
- **Evidence:** Migration `20260916140000_receipt_vat_display_toggle` documents this rationale.
- **Blast radius:** Only affects reprint semantics. **Addressed.**

### D9. Service upgrade race during installer re-run — FIXED in `fbd8a71`

- **What:** A previous version of the installer could leave credentials in a transient state if the upgrade raced with the running Service.
- **Where:** Installer + service registration.
- **Evidence:** Commit `fbd8a71` documents the resolution (stop service, write credentials, start service, in that order).
- **Blast radius:** Upgrade reliability. **Fixed.**

### D10. PREPROD build targeting Production — FIXED in `96b0024` and `da69e1d`

- **What:** An installer built without `PREPROD_BASE_URL` env var could default to Production.
- **Where:** `installer/build-preprod.ps1` (required env var); `csproj` (fails the build if not provided).
- **Evidence:** `csproj` lines 24-26 explicitly throw on missing `PREPROD_BASE_URL`. `da69e1d` adds a "fail-closed" guard.
- **Blast radius:** Build-time only. **Fixed.**

---

## J. SUSPICIONS STILL REQUIRING PROOF

> These are **not** root causes until physical evidence or targeted tests confirm them.

### S1. Printer enumeration may differ between Setup time and runtime.

- Setup enumerates printers when the Setup form opens (logged-in user context). The Service later re-enumerates printers from `NT SERVICE\TableCorePrintAgent`. If the printer driver was installed per-user (uncommon but possible), the Service will not see it.
- **Action required:** verify on the physical POS-58 that the printer is installed **per-machine**, not per-user. If per-user, instruct the user (or auto-reinstall) before Agent can print.

### S2. Server's `getAgentRoutes` may not have the latest route config if cached.

- Routes are returned by `poll` and `heartbeat`. If the Agent has been offline > a TTL, it may have stale routes when reconnecting. The heartbeat refresh fixes this on the next 25 s tick.
- **Action required:** confirm via physical test that toggling a route in Admin takes < 30 s to propagate to a live Agent.

### S3. `Workstation.availablePrinters` may be empty if the Agent never reported its enumeration.

- The Admin "select printer" dropdown is populated from this column. If the Agent's first heartbeat had no enumeration (e.g. printer driver not yet installed), the dropdown is empty forever until a successful enumeration heartbeat.
- **Action required:** the Admin UI should clearly show "Agent has not reported any printers yet" rather than an empty dropdown.

### S4. `isPrimary` semantics for CENTRAL_ROUTING across two physical kitchens.

- If two workstations have `isPrimary = true` for KITCHEN, the deterministic tie-break picks the lowest `workstationId`. There is no UI warning that multiple primaries exist for the same type — only a single route can be marked primary per the schema (the unique constraint is `(workstationId, type)`, not `(locationId, type, isPrimary = true)`).
- **Action required:** verify whether Admin UI prevents setting multiple primaries, or whether a validation warning is needed.

### S5. DPAPI `LocalMachine` scope requires the credential to be encrypted on the same machine.

- If the Agent is moved to a different PC, the credential file becomes undecryptable. This is **by design** for security, but the Setup form should clearly say "Re-pair on this new machine".
- **Action required:** verify Setup's copy text.

### S6. `PrintJob.content` is a JSON snapshot — if the menu structure changes (e.g. item renamed) after a PrintJob is created, the printed ticket still shows the old name.

- This is **historically correct** (the ticket reflected the menu at order time) but a restaurant owner may perceive it as a bug.
- **Action required:** no action — this is intended behavior. Document for the restaurant owner.

### S7. Service may not auto-restart on certain fatal exceptions.

- `AgentService.ExecuteAsync` wraps the runner in a try/catch and exits on unhandled exception. The service recovery policy (1m/2m/5m) then restarts it. But if the failure is consistent (e.g. credential file corrupt), it will loop until the user intervenes.
- **Action required:** verify the loop is observable (logs show the same crash each restart).

---

## K. MISSING TEST COVERAGE

(Discovered by file enumeration; not read in detail. These are gaps to consider before declaring P0 done.)

- No test exercising **physical Agent-to-printer happy path end-to-end** (cannot test in CI without real hardware).
- No test for **two logged-in employees on the same workstation in LOGIN_AWARE mode** swapping bindings and the second employee's order routing correctly.
- No test for **Agent crash during in-flight submission** and the recovery semantics (does the job get re-claimed? is the duplicate ACK handled?).
- No test for **service auto-restart** after fatal exception.

The following files exist and likely cover related areas (Phase 1 stopped short of running/reading them):
- `tests/integration/agent-print-delivery.test.ts`
- `tests/integration/print-routes.test.ts`
- `tests/integration/printing-modes.test.ts`
- `tests/integration/print-idempotency.test.ts`
- `tests/integration/print-hardening.test.ts`
- `tests/integration/print-routing.test.ts`
- `tests/integration/print-auto-dispatch.test.ts`
- `tests/integration/print-cancellation.test.ts`
- `tests/integration/print-reprint.test.ts`
- `tests/integration/workstation-test-print.test.ts`
- `tests/unit/print-attempt-client.test.ts`
- `tests/unit/print-transport.test.ts`

`SelfTests.cs` (the Agent's internal test suite) is a clear, evidence-rich regression set. Reading it is **recommended before any further code changes**.

---

## L. PHYSICAL INFORMATION REQUIRED

> Only what cannot be determined from code/tests.

I need **one clear physical observation at a time** when we proceed to physical QA. Below is the **planned sequence** — confirm each before moving on.

### Step 1 — Confirm the current `develop` build is what's deployed
- Pull latest `develop` to PREPROD Vercel environment (or confirm CI already has).
- Confirm PREPROD Neon branch is at the latest migration (`20260916140000_receipt_vat_display_toggle`).

### Step 2 — Fresh Windows PC + fresh Agent install
- Use a Windows machine that has **never had** a prior TableCore Agent install.
- Run the PREPROD installer (downloaded from Admin).
- Report: (a) installer SmartScreen warning or not? (b) Service starts automatically? (c) Admin sees the workstation as "Awaiting pairing" within 30 s?

### Step 3 — Pairing
- From Admin, generate pairing code.
- Enter in Setup. Confirm "Connected".
- Report: (a) Admin shows "Online" + green dot? (b) `availablePrinters` populates with the POS-58 name? (c) `printersReportedAt` timestamp is recent?

### Step 4 — Configure routes
- For KITCHEN, BAR, RECEIPT — pick the POS-58 printer and paper width.
- Report: (a) routes saved without error? (b) Agent's local view of `routes` updated within 30 s?

### Step 5 — Test Print (one route at a time)
- Click "Test Print" on KITCHEN route. Wait. Confirm physical paper.
- Repeat for BAR, RECEIPT.
- Report: (a) which printer actually printed? (b) physical layout correct? (c) did the Admin UI show success within 60 s?

### Step 6 — Real waiter order
- From the POS browser, place an order for a KITCHEN item, a BAR item, and complete payment (RECEIPT).
- Report: (a) physical KITCHEN ticket? (b) physical BAR ticket? (c) physical receipt?

### Step 7 — Mode toggle (only after Step 6 PASSes in CENTRAL_ROUTING)
- Switch Admin to LOGIN_AWARE.
- Repeat Step 6 with a logged-in waiter.
- Verify receipt still routes to the configured RECEPRINT workstation (no employee binding required for RECEIPT in LOGIN_AWARE if Admin marked it free).

### Step 8 — Recovery
- Stop the Service mid-shift (or unplug network). Restart Service. Resume shift.
- Report: (a) no duplicate physical printing? (b) in-flight jobs recovered?

---

## M. PROPOSED ROOT-CAUSE FIX PLAN

> **Important:** Based on the forensic audit, **no fresh code-level root cause is identified as unaddressed.** The committed fixes (D1–D10) match the symptoms described in the P0 brief.
>
> What remains is **physical verification** + **operational hardening** for the cases the current code does not yet cover (Section J).

### Recommendation: DO NOT PATCH CODE YET.

Three reasons:

1. The code has been iteratively corrected by prior agents. Each commit's message documents the prior defect, the reproduction, and the fix. The forensic evidence supports that the committed fixes address the symptoms described.
2. Every additional patch increases the risk of regressing one of the already-fixed defects. The paper-width fix (`6fb6fbc`) is particularly delicate — AgentRunner.cs now enforces a specific paper-width source of truth.
3. There is no remaining in-code symptom matching "physical printer does not work". A guess-based patch here would be guessing against a system whose actual behavior has not yet been observed at the physical printer.

### If physical QA reveals a fresh defect, the smallest robust fix should:

- **Stay inside the PrintJob/WorkstationPrintRoute model.** Do not bypass to direct-print.
- **Not delete either routing mode.** If a fix touches `print-policy.ts`, it must be a no-op-or-additive change to both branches.
- **Not reintroduce browser print dialogs or QZ.**
- **Include a regression test in `tests/integration/`** mirroring the symptom.
- **Be applied to PREPROD only, after migrations are confirmed in sync.**

### Sequence to follow once physical QA begins

1. **Pre-flight** (no code change):
   - Confirm `develop` HEAD is on PREPROD Vercel.
   - Confirm PREPROD Neon is on migration `20260916140000_receipt_vat_display_toggle`.
   - Verify `Restaurant.printingMode` for `test_11` is `CENTRAL_ROUTING`.
2. **Physical QA sequence** per Section L.
3. **If a defect is found**: report it in this same forensic-report format (Section I-style) with reproduction evidence. Wait for review before patching.

---

## DATABASE SAFETY NOTE

- `.env` `DATABASE_URL` resolves to Neon endpoint `ep-solitary-leaf-b1q2002q` (KNOWN_DEVELOPMENT_ENDPOINT_IDS). Confirmed PREPROD/Development.
- `.env.local` `DATABASE_URL` resolves to the **same** endpoint (non-pooler hostname). No Production endpoint in either file.
- Marker table `_rcs_database_environment` is read by `scripts/lib/db-environment.mjs` as the runtime safety boundary.
- **No Production database write is required for P0 printing.** All printing migrations are additive and already applied (or pending deployment of the latest `develop` to PREPROD).
- For any future Production release: ensure `migrate deploy` runs against the Production endpoint (`ep-tiny-base-b1rj6246`) **before** rolling out dependent code. The pre-migration and post-migration scripts (`scripts/db-premigration-check.mjs`, `scripts/db-postmigration-check.mjs`) are available for this purpose.

---

## END OF PHASE 1

I have **not modified any application code** in this phase. I have only read source.

I am ready for your review. Before I implement anything, please:

1. Confirm the forensic conclusions in this report match your understanding.
2. Confirm the physical QA sequence (Section L) matches what you can run.
3. Confirm whether any of the "suspicions" in Section J are actually known symptoms you have observed.

Only after that, proceed to any implementation.
