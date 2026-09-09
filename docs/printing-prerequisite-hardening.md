# Printing prerequisite hardening

Scope: existing browser/QZ printing authority only. No workstation pairing, agent delivery, installer, credentials or deployment. The Phase 1 Windows agent remains independent.

## Findings and fixes

1. Printer configuration upsert used the globally unique location/station key after checking only a permission. Domain validation now checks the authenticated location scope and locks a location row belonging to the authenticated restaurant before reading/writing configuration. Client restaurant fields are stripped. Delete is tenant-scoped and retains a disabled configuration instead of restoring the implicit default by deleting it. Null/global printer locations are not supported.
2. Results previously identified only the job, with counters updated by confirmation. Each successful claim now generates a random UUID, records its employee and time, and increments the counter exactly once. Results must match that attempt and employee. Identical repeated outcomes return unchanged; conflicting or stale outcomes fail. Claims, starts, results, manual requests and policy changes are audited.
3. Previously any stale PRINTING row could return to PENDING even after printing. A separate, one-shot submission-start transition now precedes transport invocation. Started attempts can never expire back to printable state.
4. Automatic creation previously ignored autoPrint. All station submit rounds and cancellation dispatches now consult the policy under the same location lock used by policy writes and claims. OFF creates no automatic PrintJob and does not affect OrderItemStation/KDS routing.

## Attempt protocol and exact recovery

The existing authenticated begin endpoint requires `X-TableCore-Print-Protocol: 2` and returns `attemptId`. The new POST `/api/pos/orders/{orderId}/print-jobs/{jobId}/start` accepts `{ "attemptId": "UUID" }`. Receive its successful response exactly once before invoking a transport. A repeated start request is rejected. A lost start response is uncertainty, never permission to print again.

The existing confirm endpoint requires `attemptId` and `outcome`, with optional bounded `errorMessage`:

| Situation | State / behavior |
| --- | --- |
| Successful claim | PRINTING; new UUID, claimant, claimedAt; increment attemptCount once |
| No start, claim younger than 90 seconds | Another claim is denied |
| No start, claim older than 90 seconds | Safe PENDING recovery on station polling or individual begin; old UUID is invalidated |
| Start requested after claim expiry | Rejected even if recovery has not run |
| Submission started | Remains non-claimable, including after restart or policy OFF |
| Started for more than 90 seconds without confirmation | Station polling marks SUBMISSION_UNKNOWN; never requeues |
| SUBMITTED_TO_SPOOLER | Legacy PRINTED status; reports spool submission, not physical paper |
| TRANSPORT_COMPLETED | Legacy PRINTED status; browser/QZ transport returned; does not assert Windows spool acceptance or paper |
| FAILED_BEFORE_SUBMISSION | FAILED; explicit controlled retry may reset to PENDING with a new claim required |
| SUBMISSION_UNKNOWN | Non-printable terminal reported outcome; explicit controlled new reprint only |
| SUPPRESSED | Non-printable historical automatic job; never automatically revived |

Timeout-generated UNKNOWN retains the active attempt with no final result, allowing a late definitive acknowledgement of that same attempt. Explicitly reported UNKNOWN is finalized and cannot be overwritten. Legacy FAILED rows lack proof of pre-submission failure and require an explicit new reprint. Receipt claims recover safely through individual begin; there is no new receipt polling worker. Started receipt attempts stay non-printable even without a station poll to relabel them UNKNOWN.

Recovery runs on requests, not a background timer. Increasing the lease is not the safety mechanism: persisted submission-start is the boundary. No automatic retry of unknown outcomes exists.

## Automatic policy

Existing `PrinterConfig.autoPrint` owns automatic Kitchen/Bar order policy. `isEnabled` remains the separate master printing switch. Existing names, station, width, copies and transport fields are retained; no new transport is introduced.

- OFF: new automatic submit/cancellation events create no print rows. KDS/order routing continues.
- Existing automatic PENDING and claimed-but-unstarted jobs become SUPPRESSED in the policy transaction. Their attempt metadata is retained for audit; start/result cannot dispatch or finalize them.
- Already-started attempts remain active and may finish. OFF cannot recall work already authorized to a physical transport. Their outcomes reconcile normally.
- Existing PRINTED, FAILED and UNKNOWN history is unchanged.
- Re-enable: only new events are eligible. `automaticSince` records the enable boundary; persisted item submittedAt/cancellation voidedAt prevent delayed dispatch calls from reconstructing events that happened before re-enable. SUPPRESSED rows never reset.
- Policy writes, creation, claim and start serialize on the tenant-owned location row, so OFF cannot race a new pre-submission dispatch past the suppression transaction.
- Missing configuration retains the existing implicit enabled/automatic default. An explicit OFF row is authoritative. Delete retains an OFF tombstone so deletion cannot silently restore ON.
- Manual ticket/reprint requests ignore autoPrint, but respect master isEnabled, tenant, location and station permissions. A manual station request has an explicit idempotency key and requester; reprints reference the original and preserve its frozen content. Safe retry becomes manual, preventing an automatic queue from consuming it.
- Receipt preview remains valid. Browser/QZ test-print helpers and the independent Phase 1 test API do not consult automatic order policy. No report screens or report job type are introduced; policy applies only to rows explicitly marked automatic station order work.

## Schema and rollout

Two ordered additive migrations add attempt metadata (`attemptId`, `claimedBy`, `claimedAt`, `submissionStartedAt`, `resultOutcome`), `isAutomatic`, `PrinterConfig.automaticSince`, and SUBMISSION_UNKNOWN/SUPPRESSED enum values. Enum addition and enum-using backfill are separate PostgreSQL transactions.

Backfill identifies existing submit/void station jobs by their established dispatch keys. Legacy PRINTING rows have no safe attempt proof and become UNKNOWN, never PENDING. Existing automatic PENDING rows under explicit OFF/master-disabled configurations become SUPPRESSED. Existing final states are not rewritten.

Only the isolated local TEST database has been migrated. Do not apply to Development/Production as part of this work. Before an approved rollout: back up, inventory station policies, stop dispatch, close old KDS/printing tabs, apply both migrations, deploy the matching server/client protocol together, then reopen clients. The protocol header rejects old automatic claim callers, but cannot recall browser code or print work already in flight. Mixed-version rolling operation is not supported. Old result payloads are rejected rather than guessed.

**Operational change:** autoPrint previously existed but was ignored. Existing explicit false values now actually stop automatic paper output; administrators must review them before rollout. No blanket backfill turns false into true. Historical paper widths/content remain immutable.

## Validation and limits

Run `node apps/print-agent/Test-TableCore.mjs` for the owned isolated PostgreSQL test database only; it ignores externally supplied TEST_DATABASE_URL. Focused unit coverage includes the client claim/start/result ordering, lost acknowledgement and conservative transport-error classification. Integration coverage exercises actual domain writes, concurrent claims/policy changes, cross-tenant access, all outcomes, rounds, cancellation and manual reprints.

Validation results for this change:

- Typecheck, lint and Next production build passed. Build environment overrides database URLs to the isolated local test database and disables external Redis configuration.
- 49 focused print/browser/QZ unit tests passed, including 6 new client protocol tests.
- The unchanged Phase 1 Windows executable passed 20 self-tests without physical printing.
- An earlier combined integration run passed 67/67. After adding two further cases, all 22 hardening cases passed together in one run; that run had an unrelated auto-dispatch setup timeout. The final combined run passed 68/69: all 47 existing regressions and 21 hardening cases; the own-location settings test timed out in its beforeEach reset, before assertions. That case passed on previous runs.
- The intermittent reset delay was observed directly in the owned test database: PostgreSQL was waiting on `IO / DataFileImmediateSync` for `TRUNCATE tenants, permissions, login_throttles CASCADE`. Timeouts and database durability settings were not relaxed. The final combined suite is therefore **not an all-green run**, despite every test having passed across runs. A stable full rerun remains a validation gate.

Exactly-once physical printing cannot be guaranteed across a database and a printer. The design favors an operator-visible uncertain outcome over duplicate paper. An operator requesting a new print must first inspect the physical printer/queue and stop any still-running original operation. Browser print-dialog cancellation cannot be reliably detected; TRANSPORT_COMPLETED deliberately records the weaker guarantee. QZ remains present and no independent agent consumer is introduced here. Durable agent reconciliation and production transport ownership remain future Phase 2 work.
