# Promotions V1 continuation audit — 2026-09-27

Continued `fe1a7dd9b6fad455ef81ed957847d78a799210cf` on `develop`, following `ecfa768`. Initial status/branch/log/fetch confirmed the local and remote checkpoint. Existing `.claude/settings.json`, `artifacts/`, and `self-test-output.txt` were preserved. No reset, stash, rebase, main checkout/push, Production DB operation, or Production deployment was performed.

## Review scope and decisions

Reviewed the Prisma schema and migration, server resolver and shared schedules, add/submit/modifier/transfer order paths, waiter snapshots and draft queues, promotion previews, Admin UI/API, role grants, audit records, and Payment/Receipt/reprint/KDS/Inventory consumers. The named Claude skills were not exposed; used repository analysis, reproduce/fix/retest, existing Vitest safety gates, and the project's Chromium/CDP fixture approach. No tools were installed.

- Financial authority remains in `promotion-service.ts`: the existing single-line and batched entry points share `evaluateLine`, use Prisma Decimal, and round to two decimal places. Add-ons are not discounted. A price-raising winner is ignored; another discount is not stacked or substituted afterward.
- Both server and preview call the same schedule/precedence selector: item target, then category, then priority, earliest creation, and lowest ID. Browser arithmetic remains display-only; no client price is accepted by the order input schema.
- Restaurant.timezone is authoritative. Start is inclusive, end exclusive. Overnight weekdays refer to the start day. Optional dates retain the existing inclusive calendar-date clipping semantics; an end date cuts off at the following midnight even inside an overnight window.
- Submit remains authoritative for **all current DRAFT units**. Old draft preview lines can have different prices but both are repriced at acceptance. Previously submitted rows are excluded and cannot absorb another unit through quantity PATCH. The UI now explains the submit-time rule.
- Payment and Receipt consume OrderItem.price; reprint consumes frozen Receipt data. Inventory receives quantities, not promotional amounts. Existing dispatch/idempotency and Printing architecture were not changed.

## Bugs reproduced and targeted fixes

| Finding | Evidence / fix |
| --- | --- |
| Optional dates failed Prisma validation | Original integration run: 24/25 passed, date-range case failed with “Expected ISO-8601 DateTime.” Convert date inputs to UTC-midnight Date objects; reject impossible/reversed dates, invalid amounts, and out-of-range priorities. |
| Submit skipped metadata refresh if price and promotion ID stayed equal | Regression showed regularPrice remained 600 instead of 700. Compare the entire pricing snapshot before updating, including name/type/value and regular price. |
| Server `"200"` and preview `"200.00"` failed to merge | Regression reproduced an unnecessary new row. Compare numeric display amounts and promotion identity, keeping distinct prices and submitted rows separate. |
| Draft `+` after expiry incremented the stale-price row | Mounted component regression produced `150 × 2`, including an unresolved POST. Read time at the tap; create a separate instant current-price unit with modifiers/note preserved. Server submission semantics are unchanged. |
| Screen opened after midnight missed overnight expiry | Regression scheduled next Friday instead of Saturday 02:00. Include yesterday's start when finding today's end; stop expired-rule timers and refresh the clock on browser resume. |
| Partial table transfer dropped all five promotion snapshot fields | Real DB regression returned null regularPrice on the copy. Copy the five fields without recalculating price or changing dispatch/inventory. |
| Audit omitted changed schedule/targets/priority | Record full before/after promotion definitions in the existing transactional audit path. |
| Admin lacked editable priority and date/value UX checks | Added priority, client validation, target search/count, accessible labels/pressed states, dialog focus handling, and >=44px promotion buttons/target rows. Preserve location scope when editing. |
| Existing waiter sessions retained stale Admin promotion rules | Return rules through the existing availability refresh; no new polling interval or add/quantity request. Keep local draft prices intact until server reconciliation/submit. |
| Fresh seeded roles lacked Promotions permissions | Add only promotions.view/manage to Owner/Admin/Manager seed grants, matching the existing backfill. |

## Executed validation

- Initial schedule file: **33/33 PASS**.
- Final focused unit selection: **178/178 PASS** across promotion-schedule (36), promotion-schemas (22), waiter-local-draft (16), waiter-shell (91), and waiter-shift-preparation (13).
- Full unit run before the final additional timezone assertion: **659 passed / 664, 5 failed**, all in `workstations-panel.test.ts`. These are the five previously isolated Printing failures reported at handoff. Printing sources/tests were not changed. The previously reported sixth failure did not reproduce in this run.
- Original Promotions integration file actually ran: **24/25**, exposing the date bug. Expanded final Promotions file: **31/31 PASS**, on the isolated, live-marker-verified `rcs_test` database at `127.0.0.1:55433`.
- Adjacent integration regression selection: **89/89 PASS** (29 Promotions tests at that point plus 60 existing item-transfer, menu-modifiers, and multi-round-ordering tests). The final two additional Promotions cases independently passed afterward. Total distinct integration cases executed successfully: **91**.
- Actual DB coverage includes percentage/fixed Decimal pricing, fractional rounding, Restaurant.timezone (Asia/Tokyo) and matching preview, targets/overlaps/inactivity/dates, snapshot preservation, actual schedule expiry, quantity mutation guards, partial transfer, Payment, Receipt **and actual reprint after deleting the promotion/changing menu price**, single dispatch, quantity-only Inventory, and stripped client price input.
- `npm run typecheck`: PASS. `npm run lint`: PASS, with the existing WorkstationsPanel `justCreatedCode` hook-dependency warning.
- Local headless Chromium, actual components/CSS with **synthetic APIs**: Admin at 320/390/768/1440px and waiter at 320/390/768px; no horizontal overflow or runtime exceptions. Admin create/edit preserved fixed price 450.50 and priority 7; switching that amount to a percentage was rejected. Screenshots/results are in local `.tmp/promotions-ui/`. The initial review identified two 40px Admin buttons; after correction the repeated matrix found no undersized Promotions buttons.
- **Authenticated PREPROD browser QA: NOT EXECUTED.** No accessible authenticated browser/CDP session was present. Synthetic fixtures are not PREPROD E2E or physical acceptance.

## Integration runner root cause

Inside the restricted shell, the existing embedded TEST PostgreSQL started and migrated successfully, but esbuild could not read the repository parent directory. Outside the sandbox, PostgreSQL startup reproduced `Greška: undefined`; enabling the existing library's log callback exposed the exact cause: **“Execution of PostgreSQL by a user with administrative permissions is not permitted.”** The library rejects without an Error when its child closes, hiding this message when `onLog` is suppressed. This matches the documented Windows limitation.

Used the already-running isolated local TEST cluster, verified database/port/data directory/live marker, and launched the existing Vitest integration configuration with an explicit TEST_DATABASE_URL. `require-test-database.ts` and the per-reset guards remained enabled. No fallback to PREPROD or Production, no guard changes, no test infrastructure redesign.

The existing `run-integration-tests.mjs` also ignores positional file arguments. For a targeted rerun against a verified disposable TEST database, use the existing Vitest CLI directly with `-c vitest.integration.config.ts tests/integration/promotions.test.ts` and an explicit TEST_DATABASE_URL. Do not use a PREPROD connection string. No startup blocker remains for the tests executed in this session.

## Migration and deployment evidence

The original `fe1a7dd` Vercel deployment was **READY**, target preview, branch develop: `dpl_3ffBqmHN2hmWKMeKqFUxDFDUrJQu` (`tablecore-4vg6h4hs9-drake-du.vercel.app`). The deployed code preceded the PREPROD database: neither Promotions nor the preceding Shift Handover migration had been applied.

Both existing migrations were inspected and are additive. Promotions creates its two tables/enums, target unique indexes/FKs, and five nullable OrderItem snapshot columns with Decimal(12,2) money. Promotion deletion SET NULLs its weak OrderItem FK without deleting the financial row; name/type/value stay frozen. No migration SQL or Prisma model was changed in this continuation.

PREPROD procedure completed:

1. Existing `resolveDatabaseTarget({argv:["--env=preprod"]})` confirmed known endpoint `ep-solitary-leaf-b1q2002q` and live marker DEVELOPMENT. Production identifiers/credentials were not used for a database connection.
2. Existing backup script produced and verified `backups/tablecore-2026-09-27-005502.dump`: 50 tables, all 14 critical tables. The three missing noncritical tables were exactly the pending new tables.
3. Saved pre-migration critical counts, then ran `node scripts/db-migrate-preprod.mjs`. Applied `20260926000000_shift_handover_table_ownership_transfer` and `20260927000000_promotions_pricing_engine` successfully.
4. Ran existing `npm run db:preprod:permissions`: eight new grants, all for promotions.view/manage on existing Owner/Admin/Manager roles. No waiter grant.
5. Verified both finished migrations, both promotion tables, all five nullable snapshot columns/Decimal precision, the grants, and **unchanged counts in every one of the 14 critical business tables**. Orders 46, OrderItems 176, Payments 25, Receipts 25, PrintJobs 92, AuditLogs 2289.

The continuation commit/deployment status is reported in the session handoff after push. **Production readiness remains gated on the [combined physical PREPROD checklist](combined-physical-preprod-qa.md), including all 22 required Happy Hour scenarios, Inventory Phase 2.5, and Shift Handover V1.**
