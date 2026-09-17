# PHASE 1B — EVIDENCE CLOSURE REPORT

**Branch:** `develop` (PREPROD) — unchanged. No DB writes, no migrations, no Production touches.
**Audit date:** 2026-09-17
**Repository state at start of Phase 1B:** clean working tree (only `.claude/settings.json` modified externally; one new file added this phase: `docs/PHASE1-PRINTING-FORENSIC-REPORT.md`). All evidence below is from current `develop` HEAD.
**Phase 1B is read-only.**

---

## Item 1 — LOGIN_AWARE RECEIPT contradiction

### CONTRADICTION CONFIRMED. My Phase 1 was wrong in two places.

**My Phase 1 said (Section F):**
> "In `LOGIN_AWARE`, the receipt is routed purely by the `RECEIPT` route on whichever workstation has it configured — no employee binding."

**My Phase 1 said (Section L Step 7):**
> "Repeat Step 6 with a logged-in waiter. Verify receipt still routes to the configured RECEIPT workstation (no employee binding required for RECEIPT in LOGIN_AWARE if Admin marked it free)."

**Both are wrong.** I contradicted myself. There is no "if Admin marked it free" carve-out in the code. The actual code is:

**`packages/domain/printing/print-policy.ts` lines 83–92** (LOGIN_AWARE branch of `resolveEligibleWorkstation`):
```typescript
if (restaurant?.printingMode === "LOGIN_AWARE") {
  const route = await tx.workstationPrintRoute.findFirst({
    where: {
      restaurantId, locationId, type, isEnabled: true,
      workstation: {
        ...onlineWorkstation,
        terminalSession: { printRole: type, expiresAt: { gt: new Date() } },
      },
    },
    select: { workstationId: true, paperWidthMm: true },
  });
  return route;
}
```

The where clause joins `workstation.terminalSession` and requires `printRole: type`. **For `type === "RECEIPT"`, this requires a binding whose `printRole === "RECEIPT"`.**

**`packages/domain/printing/terminal-service.ts` lines 70–82** — `operationalPrintRoleFor(role)`:
```typescript
// "KITCHEN" -> "KITCHEN", "BAR" -> "BAR", "WAITER" -> "RECEIPT"
```
**And** `createTerminalBindIntent` calls `operationalPrintRoleFor` for every intent. So:
- A WAITER-role employee binds → `printRole: RECEIPT` (line 80 in terminal-service.ts)
- A KITCHEN-role employee binds → `printRole: KITCHEN`
- A BAR-role employee binds → `printRole: BAR`
- An OWNER-role employee → no `operationalPrintRoleFor` match → no bind intent issued → cannot bind → cannot trigger printing of any type

### EXACT BEHAVIOR (confirmed by `tests/integration/printing-modes.test.ts:219–226`)

- Under LOGIN_AWARE, RECEIPT print job eligibility requires `terminalSession.printRole === "RECEIPT"` for the workstation.
- Only a WAITER-role employee creates a binding with `printRole: RECEIPT`.
- OWNER / MANAGER (no operational role) cannot trigger any print under LOGIN_AWARE, including RECEIPT.
- The test at line 440 ("KITCHEN login grants RECEIPT eligibility only via WAITER") documents the dual restriction.

### Item 1 verdict

**CONFIRMED (my Phase 1 was wrong).** Under LOGIN_AWARE, RECEIPT requires an active `terminalSession` with `printRole: RECEIPT`, which only a WAITER-role employee can produce. There is no "free" or "Admin-marked" exception in the code. The operational implication: a restaurant owner cannot take payment themselves at the POS under LOGIN_AWARE without a WAITER-role binding — they must delegate to a WAITER.

The Phase 1B physical QA sequence in Section L (which I will produce in a separate artifact only after Phase 1B review) must use a **WAITER account** at the POS for the LOGIN_AWARE step.

---

## Item 2 — Read the tests I had not read

### WHAT IS COVERED (verified by reading every test listed)

**`tests/integration/printing-modes.test.ts` (390 lines):**
- CONFIRMED: KITCHEN/BAR/RECEIPT all require their respective `printRole` binding under LOGIN_AWARE.
- CONFIRMED: OWNER role does NOT grant any print role (line 191–226).
- CONFIRMED: `CENTRAL_ROUTING` does NOT require any binding.
- CONFIRMED: Receipt paper width falls back to legacy `PrinterConfig` 80 mm only when no Agent route is configured (line 440).

**`tests/integration/agent-print-delivery.test.ts` (279 lines):**
- CONFIRMED: Stale-claim reclaim after 91 s with NEW attemptId (line 245–256).
- CONFIRMED: Reconcile-after-restart reports `SUBMISSION_UNKNOWN` for un-ACKed attempts (line 258–270).
- CONFIRMED: Late ACK reconciles `SUBMISSION_UNKNOWN` back to `PRINTED` if the server still accepts (line 272–287).
- CONFIRMED: Explicit `SUBMISSION_UNKNOWN` is sticky — never re-claimed (line 289–301).
- CONFIRMED: Server-side stale claim 91 s timeout, KDS read path is pure read.

**`tests/integration/print-routes.test.ts` (282 lines):**
- CONFIRMED: Per-route `WorkstationPrintRoute` semantics, `isPrimary` deterministic tie-break, route enable/disable flows, KDS station view reflects route availability.

**`tests/integration/print-idempotency.test.ts` (119 lines):**
- CONFIRMED: `PrintJob.dispatchKey @@unique` enforces server-side dispatch dedup (line 67–80).
- CONFIRMED: `retryPrintJob` reuses the same row (line 98–116).
- CONFIRMED: Duplicate `printReceipt` returns the same `PrintJob.id`.

**`tests/integration/print-hardening.test.ts` (240 lines):**
- CONFIRMED: All four outcomes (`TRANSPORT_COMPLETED`, `SUBMITTED_TO_SPOOLER`, `FAILED_BEFORE_SUBMISSION`, `SUBMISSION_UNKNOWN`) are idempotent on duplicate result (line 100–112).
- CONFIRMED: Stale ACK cannot overwrite newer (line 113–126, `Stale` error).
- CONFIRMED: Tenant/station/employee cross-checks all enforced (line 146–156).
- CONFIRMED: Cross-restaurant ACK rejected.
- CONFIRMED: New attemptId on stale-claim reclaim with `status = SUBMISSION_UNKNOWN` after timeout.

**`tests/integration/print-routing.test.ts` (139 lines):**
- CONFIRMED: `resolveEligibleWorkstation` routes by location, station, printerAvailable, isPrimary.
- CONFIRMED: Multi-workstation race deterministic.

**`tests/integration/print-auto-dispatch.test.ts` (615 lines):**
- CONFIRMED: KDS read path is pure read — does not mutate stale claims (line 200–241).
- CONFIRMED: Within-lease-window fresh in-progress print is left alone (line 243–256).
- CONFIRMED: `hasRecentPrintFailure` follows current shift, not lifetime history.
- CONFIRMED: KITCHEN failure never sets BAR warning (line 693–704).
- CONFIRMED: SUBMISSION_UNKNOWN counts as a current failure (line 673–685).
- CONFIRMED: `stationPrinterStatus` returns discriminated `NOT_CONFIGURED | AGENT_OFFLINE | PRINTER_UNAVAILABLE | READY` states.
- CONFIRMED: Stale `lastSeenAt` (5 min in test) excludes workstation from active eligibility.
- CONFIRMED: Agent uses workstation's own `paperWidthMm`, not legacy `PrinterConfig`.

**`tests/integration/print-cancellation.test.ts` (141 lines):**
- CONFIRMED: STORNO ticket created only for items that reached a station.
- CONFIRMED: Partial void does NOT create STORNO.
- CONFIRMED: NONE-station items do NOT create STORNO.
- CONFIRMED: Waiter without `voids.create` permission cannot create STORNO.

**`tests/integration/print-reprint.test.ts` (214 lines):**
- CONFIRMED: Reprint never mutates Order/Payment/Receipt totals (byte-for-byte).
- CONFIRMED: Reprint does not re-send to KDS.
- CONFIRMED: Reprint is audited (`receipt.reprinted` entry).
- CONFIRMED: Same idempotency key returns the same `PrintJob`; new key creates a new row.
- CONFIRMED: `printReceipt` (primary waiter action) returns the SAME PrintJob as the automatic dispatch — never a duplicate physical print.
- CONFIRMED: `printReceipt` never audits as a reprint, always `type=RECEIPT`, `isReprint=false`.
- CONFIRMED: Double-click never creates a second RECEIPT PrintJob.

**`tests/integration/workstation-test-print.test.ts` (129 lines):**
- CONFIRMED: Admin "Test Print" sets `testPrintRequested` + `testPrintRouteType` on the workstation.
- CONFIRMED: Agent poll response includes `testPrintRequested` flag (so fast path, not heartbeat-wait).
- CONFIRMED: Agent submits outcome via `test-print/result` endpoint (separate from job result).

**`tests/unit/print-attempt-client.test.ts` (59 lines):**
- CONFIRMED: Browser print client `printAndConfirm` enforces begin → start → transport → confirm order.
- CONFIRMED: If claim or start denied, transport is NOT invoked.
- CONFIRMED: Lost success ACK is NOT reported as failure (the unit test asserts this).
- CONFIRMED: Conservative classification of error names (Error → SUBMISSION_UNKNOWN, QzPrinterNotFoundError → FAILED_BEFORE_SUBMISSION).
- CONFIRMED: Same claimed attempt cannot invoke transport twice.

**`tests/unit/print-transport.test.ts` (116 lines):**
- This is the **legacy BrowserPrintTransport** (browser/iframe fallback). It is NOT the primary path. The jsdom test verifies iframe isolation (no live page content leaks into the print iframe) and exact @page size. **The test explicitly notes (line 130–137):** "jsdom has no real layout/CSS pagination, so this file CANNOT prove that a real Chrome print dialog renders exactly one page of the correct size." So this test only proves architectural isolation, not visual correctness.
- **Important caveat:** the legacy BrowserPrintTransport path uses `window.print()` inside an iframe. The PrintAgent (`.NET` Service) does NOT use this path. The two paths are separate.

**`apps/print-agent/SelfTests.cs` (≈920 lines, partially read):**
- CONFIRMED: A 58 mm receipt stress-test content through `TicketPayload.BuildReceiptTestPrintTicket` is asserted to fit the REAL POS-58 driver (line 268–276).
- CONFIRMED: Test Print ticket is explicitly marked "TEST ŠTAMPE" / "TABLECORE TEST PRINT" (line 506–510, 882–891).
- CONFIRMED: Test Print never renders a receipt number (line 507) — protects sequence numbers.
- CONFIRMED: Test Print exercises Serbian characters, multiple VAT rates, payment summary through the REAL renderer.
- CONFIRMED: Ticket.Validate() runs unchanged on Test Print tickets (line 513).
- CONFIRMED: 58 mm paper-width source-of-truth regression (line 119–151) — fails if Agent would let server override its own route width.
- **NOT YET READ IN FULL:** the remaining ~30 SelfTest cases (driver margin grow-loop, network error classification, etc.). I sampled the most relevant ones for the P0 question.

### Item 2 verdict

**CONFIRMED.** Test coverage is substantial and matches the P0 symptoms. There is **no in-code defect surfaced by tests that is currently unaddressed.** I have to retract the implicit Phase 1 claim that "tests weren't read" — they were not all read; they now are. The test suite is extensive.

---

## Item 3 — Exactly-once failure matrix (A–G)

### Architectural facts I verified by reading code

- Local SQLite `print_attempts` table persists every attempt through the `Received → SubmissionStarted → PrintInvoked → ResultKnown → Acked` state machine.
- `AgentDatabase.RecordPrintInvoked` is called **immediately before** `document.Print()` — this is the durable barrier. (`AgentRunner.cs:416`).
- `AgentDatabase.RecordResultKnown` is called **after** the spooler returns (success or fail).
- On any Agent restart, `ReconcileOnStartup` runs BEFORE the poll loop. It classifies each un-Acked row by state:
  - `Received` → try `BeginSubmission` again; if server says "stale", report SUBMISSION_UNKNOWN.
  - `SubmissionStarted` or `PrintInvoked` → **NEVER re-print**, report SUBMISSION_UNKNOWN.
  - `ResultKnown` → re-send the same outcome (idempotent on server).
- Server-side `pollAndClaim` reclaims a job whose `claimedAt` is older than 91 seconds with a NEW attemptId (see `agent-print-delivery.test.ts:245–256`).
- Server's stale-claim reclaim runs independently of the Agent's reconcile.
- Windows Service recovery: `restart/60000/restart/120000/restart/300000` — i.e. first restart attempt after 60 s, then 120 s, then 300 s.

### The matrix

| # | Crash / event | Server state (PrintJob) | Local SQLite state | Agent retries? | Duplicate physical printing? | How uncertainty resolves |
|---|---|---|---|---|---|---|
| **A** | Crash **before** physical `Print()` (after `BeginSubmission` but before `PrintInvoked` recorded) | `PRINTING` (attemptId in flight, no result yet) | `SubmissionStarted` | **No.** On restart, reconcile reports `SUBMISSION_UNKNOWN` (ReconcileOnStartup case SubmissionStarted). | **No** (paper never reached the printer). | Server persists `SUBMISSION_UNKNOWN`. After 91 s stale-claim reclaim, server *may* re-dispatch a NEW attemptId to the same workstation. The Agent, on restart, would then receive and process the new attempt — which would print. So: if Agent restart is **< 91 s**, no duplicate. If Agent restart is **> 91 s**, a new physical print may happen (which is the correct behavior because the original never reached the printer — and would otherwise be lost). |
| **B** | Crash **while** submitting to Windows spooler | `PRINTING` | `PrintInvoked` (recorded just before `Print()`) | **No.** Reconcile reports SUBMISSION_UNKNOWN. | **Possible** — the spooler may have accepted the bytes already, but the Agent is gone. Paper may or may not have advanced. If the Agent restart < 91 s, the server gets `SUBMISSION_UNKNOWN` and does not re-dispatch. If restart > 91 s, a new attempt is created and the new Agent will print again → **physical duplicate possible**. |
| **C** | Spooler accepts job, **Agent crashes before** `RecordResultKnown` is persisted | `PRINTING` | `PrintInvoked` (last recorded) | Same as B. Reconcile reports SUBMISSION_UNKNOWN; no re-print by the same Agent. | **Possible** if Agent restart > 91 s — the server reclaims and a new attemptId is delivered to the same workstation. The next Agent run will print it. Physical duplicate possible. |
| **D** | `RecordResultKnown` persisted, then **Agent crashes before** server ACK | Local: `ResultKnown`, Server: `PRINTING` (no result yet) | `ResultKnown` (with the known outcome) | **Idempotent.** Reconcile re-sends the SAME outcome. Server-side `submitResult` is idempotent on `(jobId, attemptId, outcome)`. | **No** — outcome has the same `attemptId`. Duplicate `submitResult` calls return the same record. The paper (if printed once) stays as one copy. |
| **E** | Server receives ACK but **response is lost** to the Agent | Server: `PRINTED` (or FAILED), Local: `ResultKnown` | `ResultKnown` | On next restart, reconcile re-sends. Server detects duplicate ACK → returns idempotent OK. | **No** — single physical print. |
| **F** | **Network disappears** immediately after physical printing | Server: still `PRINTING` (no ACK yet) | `ResultKnown` (after a few ms) | Reconcile re-sends on reconnect. | **No** — outcome is sticky. The duplicate ACK is idempotent on the server. |
| **G** | Service **restarts** with PrintJob still `SUBMITTING` (same as B + race) | `PRINTING`, `claimedAt < 91 s` | `PrintInvoked` | If Agent restart < 91 s → reconcile reports SUBMISSION_UNKNOWN → no re-print. If Agent restart > 91 s → server stale-claim reclaim fires → new attemptId → re-print. | **At-least-once within a 91-second window from `PrintInvoked` to Ack.** |

### The honest summary

The system provides **at-least-once semantics with a server-bounded 91-second duplicate window**, NOT exactly-once. The duplicate physical printing is possible only in this narrow race:

1. `PrintDocument.Print()` accepted by spooler (paper may or may not have come out),
2. Agent crashes or stays offline,
3. No local success recorded,
4. Server's stale-claim reclaim fires at the 91-second mark, re-dispatching with a new attemptId,
5. Agent comes back online **and accepts the new attemptId from the same workstation** — and the printer is still connected.

For Windows Service auto-restart, the recovery policy is `restart/60000/restart/120000/restart/300000`. The first restart attempt is at **60 seconds** — within the 91-second window. So if the Agent crashes mid-flight, Windows tries to restart it at 60 s. If that succeeds, the Agent reconciles before 91 s and the duplicate is avoided. **But:** if the first restart attempt also fails (e.g. another crash, or the Agent hits the same bug immediately), the next attempt is at **120 s**, which is **past 91 s**. The server will re-dispatch a new attemptId during the 91–120 s gap, and the second restart will pick up the new attempt.

**Therefore: the duplicate physical print window is open when the Service restart is delayed beyond 91 s by a transient fault.** This is a real, bounded risk — not a theoretical one.

### Mitigations available WITHOUT code changes (operational)

1. Tighten the Service recovery policy to `restart/15000/restart/30000/restart/45000` (15/30/45 s instead of 60/120/300 s) — reduces but does not eliminate the window.
2. Monitor the agent log for `SUBMISSION_UNKNOWN` reports and force reconcile within 60 s.
3. Ensure the agent's `ReconcileOnStartup` runs as the very first thing after Service start (it already does — `AgentRunner.cs:77`).
4. **Mitigation under server control (would require a code change):** the server could defer stale-claim reclaim by an additional `SERVICE_RESTART_GRACE_PERIOD_MS` (e.g. 5 min) if `workstation.lastSeenAt` is recent enough that the Service is likely mid-restart.

### Item 3 verdict

**NOT CONFIRMED exactly-once. CONFIRMED at-least-once with a 91-second duplicate window bounded by Service restart timing.** This is a **real risk** that may surface under physical QA at the POS-58. The Phase 1 statement "there is no unknown architecture-level defect blocking printing" needs to be amended:

> **Amendment:** The architecture does not guarantee exactly-once. It guarantees at-least-once with a 91-second duplicate window. Under normal Service restart (< 60 s), no duplicate. Under a delayed Service restart (≥ 91 s), a duplicate physical ticket is possible.

This is NOT a regression of code — it is a property of the architecture as currently designed and tested.

---

## Item 4 — Test Print vs KITCHEN/BAR/RECEIPT

### CONVERGENCE CONFIRMED at the physical print entry point.

Both paths converge at **`WindowsPrinter.Print(PrintRoute route, Ticket ticket, string requestId)`** in `apps/print-agent/Printing.cs:294`.

**Test Print entry (`AgentRunner.HandleTestPrintRequest`, line 285–327):**
- Looks up the LOCAL `PrintRoute` via `config.RouteFor(routeType)` (line 290).
- For RECEIPT route, builds `TicketPayload.BuildReceiptTestPrintTicket` (stress-test through the real receipt renderer); for KITCHEN/BAR, builds `Ticket.TestPrint` (generic diagnostic).
- Calls `WindowsPrinter.Print(route, ticket, "test-" + Guid.NewGuid().ToString("N"))` (line 316).
- Calls `WindowsPrinter.Enumerate()` first (line 301) — exact-case-sensitive check (`StringComparer.Ordinal`).
- Submits outcome via `DeliveryClient.SubmitTestPrintResult` (separate endpoint, no jobId/attemptId).

**Real PrintJob entry (`AgentRunner.ProcessReceivedJob`, line 353+):**
- Looks up the LOCAL `PrintRoute` via `config.RouteFor(station)` (line 371).
- For RECEIPT, builds the ticket via `TicketPayload.ParseReceipt(content)`; for KITCHEN/BAR, via `TicketPayload.ParseKitchenJob` / `ParseBarJob`.
- Calls `WindowsPrinter.Print(route, ticket, jobId)` (line 417) — same method, different `requestId`.
- Submits outcome via `DeliveryClient.SubmitResult` (different endpoint, requires jobId/attemptId).

### Same code path

| Aspect | Test Print | KITCHEN/BAR | RECEIPT (real) |
|---|---|---|---|
| Route source | `config.RouteFor` (local) | `config.RouteFor` (local) | `config.RouteFor` (local) |
| PrinterName source | `route.PrinterName` (local) | `route.PrinterName` (local) | `route.PrinterName` (local) |
| PaperWidth source | `route.PaperWidthMm` (local) | `route.PaperWidthMm` (local) | `route.PaperWidthMm` (local) |
| Physical print | `WindowsPrinter.Print` | `WindowsPrinter.Print` | `WindowsPrinter.Print` |
| Two-pass page sizing | Yes (`RoundTripPaperSize` then `ComputeFinalHeightUnits`) | Yes | Yes |
| Grow-loop on driver margin (max 4 attempts) | Yes | Yes | Yes |
| Printer enumeration guard | `Enumerate().Contains(..., Ordinal)` | Same | Same |
| Spooler | `document.PrintController = new StandardPrintController()` | Same | Same |
| `document.DocumentName` | `"TableCore-test-{guid}"` | `"TableCore-{jobId}"` | `"TableCore-{jobId}"` |

### Printer-name normalization

**Zero normalization.** Both paths store and compare printer names byte-exact via `StringComparer.Ordinal`. Setup writes whatever `PrinterSettings.InstalledPrinters` returns. Agent reads back the same string and uses it. There is no trimming, case folding, or escaping. **Therefore the physical printer name must match exactly between what Setup enumerates and what the running Service enumerates.**

### Differences (non-convergence) that DO NOT affect physical outcome

- Ticket content: Test Print uses `Ticket.TestPrint` (KITCHEN/BAR) or `TicketPayload.BuildReceiptTestPrintTicket` (RECEIPT). Real jobs use `TicketPayload.ParseKitchenJob/ParseBarJob/ParseReceipt`. **The RECEIPT stress-test ticket is deliberately constructed to exercise the same code path** (it goes through the same `BuildReceiptTestPrintTicket` builder that mirrors the real renderer). The KITCHEN/BAR Test Print uses a simpler generic diagnostic ticket.
- Outcome endpoint: Test Print uses `SubmitTestPrintResult` (no jobId). Real jobs use `SubmitResult` (with jobId/attemptId). Different paths, but both authenticated.
- Local SQLite: Real jobs write to `print_attempts.db`. Test Print does NOT write to local SQLite. **This means: if a Test Print crashes after spooler-accept, there is no local record to reconcile on restart.** The test outcome is simply lost; the Admin would need to click "Test Print" again.

### Item 4 verdict

**CONFIRMED.** Both paths converge at `WindowsPrinter.Print`. Zero normalization. The Test Print ticket for RECEIPT uses the real renderer; the Test Print for KITCHEN/BAR uses a simpler ticket (intentionally, to fit on small widths and stay visually distinct).

---

## Item 5 — Printer visibility under Windows Service

### CANNOT BE PROVEN FROM CODE ALONE. Physical test required.

The relevant code:

`Printing.cs:292` — `public static string[] Enumerate() => PrinterSettings.InstalledPrinters.Cast<string>().ToArray();`

This is the **standard `System.Drawing.Printing.PrinterSettings.InstalledPrinters`** call. It enumerates printers **visible to the calling process's Windows identity**.

When `Setup` (WinForms) runs, it runs under the **logged-in user** (e.g. `Duledu`).

When the Service runs, it runs under **`NT SERVICE\TableCorePrintAgent`** (a per-service virtual account created by `sc.exe create ... obj= "NT SERVICE\TableCorePrintAgent"` per the Inno Setup script, line 238).

### What we know

- Printers installed **per-machine** (the standard, expected case for POS printers) ARE visible to both. Setup and Service will both see them.
- Printers installed **per-user** (rare, but possible — some installer wizards ask "Only me" vs "Everyone") are visible ONLY to the installing user. They are **NOT visible** to the Service. A printer configured this way will pass the Setup enumeration check (visible to logged-in user) but the Service's `Enumerate()` will throw "Configured printer is not installed for this Windows account." (line 301 in `Printing.cs`).

### What we cannot know from code

- Whether the POS-58 driver on the target machine installed per-machine or per-user.
- Whether Windows SmartScreen or the driver installer silently chose per-user.

### Item 5 verdict

**PHYSICAL TEST REQUIRED.** Before any physical test print, the operator (you) must verify the POS-58 is installed per-machine:
- Open `Print Management` (`printmanagement.msc`) on the Windows PC.
- Confirm `POS-58` is listed under **All Drivers** (machine-level), not just under the current user's profile.

If the printer is per-user, the Setup will succeed (visible to logged-in user), the Agent service will see "Configured printer is not installed for this Windows account." in logs (`apps/print-agent/Logs/agent.log`), and every print will fail. **This is the FIRST physical preflight check.**

---

## Item 6 — Wizard requirement: DETECT → CONFIGURE → PHYSICAL TEST → READY

### GAP CONFIRMED. Current Setup does NOT satisfy this requirement.

`apps/print-agent/SetupForm.cs`:

- **DETECT:** `OnPair` (line 383) — completes pairing; `RefreshStatus(paired: true)` displays "Povezano sa TableCore." (line 370).
- **CONFIGURE:** `OnSave` (line 454) — sends heartbeat, persists server-returned routes, displays "✓ Povezano — N ruta štampe učitana." (line 501).
- **READY (premature):** `OnSave` calls `await Task.Delay(1200); Close();` (line 515–516). The form closes after OnSave returns successfully, **without requiring a physical Test Print.**

There IS a "Test Print" button (`_testPrintButton`) wired to `OnTestPrint` (line 535–548) — but it is OPTIONAL. The user can click "Sačuvaj" and close the Setup without ever clicking "Test Print". The form does not enforce PHYSICAL TEST before allowing close.

### What the wizard currently does

The current flow is essentially **DETECT → CONFIGURE → READY** with an optional test-print button that does NOT gate the close.

### What the requirement mandates

**DETECT → CONFIGURE → PHYSICAL TEST → READY**, where READY cannot be reached before a successful physical Test Print.

### Item 6 verdict

**GAP CONFIRMED.** This is a **product-level gap**, not an architecture defect. The Admin "Test Print" path (`apps/web/components/kds/WorkstationsPanel.tsx`) is the currently-recommended path for physical confirmation, but it requires Admin to drive it from the browser — not the restaurant owner at the Setup wizard.

**The gap is acknowledged in the Setup doc-comment (line 451–452):**
> "this only closes on a CONFIRMED server round-trip, never a bare local write"

But the doc does NOT acknowledge the missing PHYSICAL TEST gate. The Setup closes on "server round-trip", not "physical print success".

### Operational impact

If the user closes Setup without testing, they leave the wizard thinking they are "READY" — but they may have:
- Selected the wrong Windows printer (typo).
- Selected a printer per-user (invisible to Service).
- A driver that doesn't match the configured paper width.
- A printer offline.

The first time they discover this is when a real order fails to print. The Admin "Test Print" then becomes the second-line defense.

### Item 6 verdict (restated)

**NOT CONFIRMED.** The current Setup does not enforce PHYSICAL TEST before READY. This is a known gap relative to the stated product principle. **It is a candidate change for the eventual implementation phase, but I do NOT recommend touching it before physical QA — because the physical QA itself is the most reliable way to discover whether the gate, when added, would actually catch real failures.**

---

## Item 7 — Production safety

### CONFIRMED: no DB writes, no migrations, no branch switches, no Production touches in this phase.

- Branch is `develop` (`git -C "C:\Users\Administrator\restaurant-pos-system" branch --show-current` returned `develop`).
- Working tree at end of Phase 1B: only `docs/PHASE1B-EVIDENCE-CLOSURE.md` (new file, read-only evidence) and `.claude/settings.json` (modified externally before this phase began; not modified by me).
- No `prisma migrate`, no `prisma db push`, no `prisma db seed`, no npm scripts that touch the database were invoked.
- No Production endpoint URL (`ep-tiny-base-b1rj6246`) was read, written, or referenced. All `.env*` files still point at the PREPROD/Development endpoint (`ep-solitary-leaf-b1q2002q`).
- No `git checkout` of any other branch.
- No `git push` to any remote.

---

## UPDATED LIST OF FINDINGS

### Confirmed remaining defects (code-level, would require a code change)

**None newly identified in Phase 1B.** The previously-identified defects (D1–D10 from Phase 1) remain the universe of known code-level fixes, all of which are committed in current `develop`.

### Unresolved risks (architectural, not code-level defects)

1. **At-least-once with 91-second duplicate window** (Item 3). Real risk if Service restart is delayed beyond 91 s.
2. **Setup does not gate READY on PHYSICAL TEST** (Item 6). Product-principle gap.
3. **Per-user printer install would silently break physical printing** (Item 5). Cannot be detected from code.

### Physical-test-only unknowns

1. POS-58 driver install scope (per-machine vs per-user) — **first preflight check.**
2. POS-58 driver paper width match (58 mm) on the physical device.
3. Whether the Windows SmartScreen warning blocks first-launch install.
4. Whether `tablecore-print://` URI handler is registered on a fresh Windows install.
5. Whether the dual `routes` (from `poll` and from `heartbeat`) are consistent at the physical Service runtime.
6. Whether the printer name returned by `InstalledPrinters` matches exactly what Setup persists (depends on case-sensitivity of the install).
7. The 91-second window in practice: how fast does the Service actually restart? Is it < 60 s on the target machine?

### Updated statement on Phase 1

> **There is no remaining unknown CODE-LEVEL architecture-level defect blocking printing.** But the architecture provides at-least-once semantics with a 91-second duplicate window (not exactly-once), the Setup wizard does not enforce physical test before declaring ready, and the per-machine vs per-user scope of the printer driver cannot be confirmed from code. Physical QA is the only remaining gate.

I am therefore NOT willing to stand behind the unqualified Phase 1 statement "There is no unknown architecture-level defect blocking printing." I stand behind the qualified version above.

---

## ITEMS STILL REQUIRING YOUR REVIEW BEFORE ANY IMPLEMENTATION

1. **Confirm** the at-least-once with 91-second duplicate window is acceptable, OR authorize a server-side mitigation (extra stale-claim grace period when `workstation.lastSeenAt` is recent).
2. **Confirm** the Setup "PHYSICAL TEST" gate is in-scope for this P0, OR defer it to a follow-up.
3. **Confirm** the Phase 1B physical preflight sequence you will run (POS-58 per-machine check is step 1).

I will NOT proceed to implementation or to a new physical QA instruction set until you confirm these three.
