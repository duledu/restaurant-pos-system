# Normativi + Inventory V1 audit — 2026-09-27

Starting point: `develop`, local/origin `053c8bf` (Promotions continuation). Repository status, branch, ten commits and `git fetch origin` were checked first. Existing `.claude/settings.json`, `artifacts/` and `self-test-output.txt` were preserved. This is a continuation of the existing engine. No Prisma schema or migration changes, new stock tables, refund engine, or Phase 3 work.

**Physical PREPROD acceptance remains PENDING. Not Production-ready.** See the [combined checklist](combined-physical-preprod-qa.md). Evidence below distinguishes code review, executed isolated database tests and synthetic browser checks.

## Existing architecture — CODE REVIEWED

`MenuItem.inventoryTrackingMethod` is the authoritative routing gate. Legacy `trackStock` is retained for compatibility; it does not create a second deduction path.

| Method | Stored configuration | Payment effect |
| --- | --- | --- |
| NO_TRACKING | No required stock configuration; old rows may remain frozen | No movement |
| DIRECT_STOCK | `InventoryItem`, unique location/menu item; free-text unit label | One stock unit per sold unit in `InventoryMovement` |
| RECIPE | `MenuItemIngredient` joins MenuItem to Ingredient with canonical quantity | Quantity × sold units, aggregated per ingredient, in `IngredientMovement`; current balance in `IngredientStock` |

The existing services are `packages/domain/inventory/{inventory,ingredient,inventura}-service.ts`, `packages/domain/menu/recipe-service.ts`, `billing/billing-service.ts` and `billing/split-bill-service.ts`. Admin Menu and Admin Normativi share `RecipeModal`; the guided direct-stock flow uses the existing `DirectStockModal`. Opening stock, receipt, adjustment, write-off and Inventura all reuse these services/ledgers.

The authoritative deduction point is **successful payment**, inside the same database transaction as the payment. Full and split payments deduct accepted, unpaid quantities. Add, submit, KDS processing, pickup, ownership handover, item transfer and receipt/reprint do not deduct. Submit still validates configuration; no synchronous inventory work was added to instant local waiter interactions.

Payment locks/paid quantities and unique SALE payment/item or payment/ingredient identity prevent duplicates. Stocks use atomic database increments/decrements rather than a JS read/calculate/write balance. Historical movements retain delta, before/after, location, item/ingredient, timestamp and order/payment references. Manual movements record employee/reason; SALE actor can be traced through `Payment.completedBy` (its movement employee field may be null).

Draft removal and supported pre-payment voids have no SALE effect. Paid quantities cannot be voided through that path. There is no supported refund/payment-cancellation stock reversal engine. Prepared waste requires the existing explicit write-off. Recipes/tracking are read at payment; there is no recipe snapshot at submit. Later recipe edits do not rewrite completed SALE movements.

Sales intentionally allow zero/negative recorded stock, including missing location balances initialized from zero. Manual negative adjustments/write-offs cannot worsen stock below zero. An unconfigured RECIPE item remains a configuration error. No stock-policy change was made.

## Units and quantities

Ingredient.unit is the canonical storage unit for its stock, recipe quantities and history. It may be kg, g, l, ml or PIECE/kom; storage is not globally grams or millilitres. All relevant quantities are existing Prisma `Decimal(12,3)`. Compatible recipe entry units convert before persistence: 1 kg = 1000 g and 1 l = 1000 ml. Mass/volume/count dimensions cannot mix.

Authoritative conversion and movement arithmetic now remain Decimal. Existing numeric API/display values are retained. A normative must be exactly representable at three canonical decimal places; finer entries are rejected with a Serbian explanation rather than silently rounding to zero. Configure an ingredient in g/ml for finer quantities. Changing its unit after creation is rejected because historical rows have no separate unit snapshot; create a new ingredient instead. No historical quantities were relabelled or rewritten.

## Reproduced defects and targeted fixes

| Evidence | Root cause | Fix and repeat verification |
| --- | --- | --- |
| kg ingredient could be changed to g without converting stock/recipe/history | Mutable canonical-unit label | Reject unit changes; isolated DB regression passes |
| 0.4 g entered for a kg ingredient became zero consumption | Decimal(12,3) persistence rounded an unsupported canonical quantity | Decimal conversion + explicit canonical precision validation; regression passes |
| Zero-all reactivated NO_TRACKING and overwrote its frozen stock | It excluded RECIPE rather than selecting DIRECT_STOCK | Select current DIRECT_STOCK only; regression passes |
| With stock 10, queued receipt +2 and opening target 5, ledger summed to 7 while balance was 5 | Opening reconciliation read balance before acquiring its write lock | Lock existing/missing stock via atomic no-op upsert, then calculate delta; raw bulk, finished bulk and single initialization regressions pass |
| Confirmed DIRECT_STOCK reactivation raced a receipt and recorded an incorrect zeroing delta | Stale pre-transaction balance | Lock/read fresh balance before zeroing; deterministic DB regression passes |
| Count edit raced confirmation, leaving displayed physical count 9.7 but stock 9.4 | Count lines read/edited outside a shared session lock | Serialize edits/recounts/additions/confirmation on the session and read fresh lines; regression passes |
| Three simultaneous count starts created three OPEN sessions | Check-then-create without serialization | Lock the location for start/resume; regression deliberately queues concurrent inserts and now returns one session |
| Recipe add/update/remove persisted despite injected audit failure | Audit written after transaction | Recipe mutation, first-method transition and audit share one transaction; all three failure-injection regressions pass. Inventura start/confirmation audits are also transactional |
| Six simultaneous submits repeatedly timed out in the existing Handover test | Each submit transaction asked the five-connection pool for additional pricing/availability connections | Pass existing transaction to existing batched pricing/availability readers; unchanged pricing semantics, Handover 24/24 passes |
| Existing Phase 2.5 test failed on `"9"` versus `"9.000"` | Decimal string-format assertion, not stock error | Assert exact Decimal equality; 25-unit scenario passes |
| Fresh seed roles omitted Inventory grants | Permission migrations execute before fresh role creation | Seed definitions match existing migration/backfill policy; code-reviewed against PREPROD grants, seed not run against PREPROD |
| Local Chromium showed native recipe confirmation and phone-width Inventory filter overflow | Native confirm, nonwrapping filter row | Existing Button-based confirmation, wrapped filters; repeated browser matrix passes |

Recipe UI also has explicit save/error feedback, duplicate-submit protection, dialog focus handling, labelled unit/quantity controls and larger internal touch targets. Tracking-method confirmations now use an application dialog. Inventura displays kg/g/l/ml/kom instead of enum names. No whole-app redesign or printing change.

## Permissions, isolation and audit

Central permission checks and restaurant/location scopes remain authoritative. Existing tests actually exercised foreign restaurant/ingredient/recipe access, unauthorized locations, Location A versus B stock, waiter restrictions, opening-stock restrictions and count override permissions.

| Existing role policy | Inventory grants |
| --- | --- |
| OWNER / ADMIN | view, manage, count, opening_stock |
| MANAGER | view, manage, count |
| INVENTORY_MANAGER | view, count; no arbitrary adjustments/normative editing |
| WAITER | none; normal order/payment can still invoke server deduction |

Normative editing uses `inventory.manage`, reading uses `menu.view`. Count confirmation uses `inventory.count`; stale-count override is restricted by the existing Owner/Admin policy. Opening stock uses its separate permission.

Sensitive manual stock actions have durable movement rows with actor, time, reason and delta, plus audit entries. Some existing manual service audit calls remain after the committed ledger transaction, so a failure of that secondary audit can return an error after the stock operation; the ledger still records who changed what. Recipe changes had no equivalent movement history, so their demonstrated audit atomicity gap was fixed. This audit does not claim a new global exactly-once contract for manual receipts/write-offs. Do not blindly retry an ambiguous manual request; reconcile its movement history.

## TEST WRITTEN and TEST ACTUALLY EXECUTED

All 17 new cases in `tests/integration/inventory-audit.test.ts` were executed against isolated local `rcs_test` at `127.0.0.1:55433`. Existing live TEST marker and per-reset guards remained enabled. No reset tests touched PREPROD. The existing embedded PostgreSQL worked inside the restricted shell; Vitest ran against that explicit TEST URL with the unchanged integration config. No test-infrastructure redesign or new tools.

Validation sequence:

- Existing relevant units first: **16/16 PASS** (unit conversion, stock status, formatting).
- Initial existing Inventory integration selection: **189/190**, one formatting assertion described above.
- Initial adjacent selection: **171/172**, one six-waiter connection-pool failure described above; repeated to diagnose, then Handover passed **24/24**.
- Broad integration regression: **377/377 PASS**, 17 files. Covers Inventory, tracking, both opening-stock flows, ingredients/recipes, availability, Inventura, categories, Phase 2.5, ingredient SALE, split billing, void, item transfer, Handover, Promotions and multi-round ordering.
- Final additional deterministic concurrency checks initially failed **2/2**, then passed **2/2** after the fixes.
- Final affected regression selection: **71/71 PASS** (audit 16, Inventura 18, tracking 29, Phase 2.5 8). These overlap the broad run; do not add the counts as distinct tests.
- Final audit file with explicit draft quantity 1→2→1, removal and submitted void coverage: **17/17 PASS**; fixture also typechecked separately.
- Strengthened Phase 2.5 assertions verify actual SALE ledger rows as well as stock for three Coca-Colas and 600/60/60 g: rerun **8/8 PASS**.
- Full unit suite: **660 PASS / 665 total, 5 FAIL**, all in pre-existing `tests/unit/workstations-panel.test.ts` (heartbeat convergence, route readiness, printer availability/readiness, printer selection, LOGIN_AWARE role). Printing sources/tests were untouched; these are the same five failures documented in the preceding Promotions audit.
- Repository typecheck and explicit typecheck of both touched integration files: PASS. Root tsconfig excludes tests, so the latter was run separately.
- Lint: PASS with existing `WorkstationsPanel` `justCreatedCode` hook warning.

Executed acceptance evidence:

- NO_TRACKING: no SALE movement, including retained historical configuration.
- Coca-Cola ×3: exactly three finished-stock units consumed.
- Punjena pljeskavica: saved/reopened 300/30/30 g; ×2 consumes 600/60/60 g; two rounds 2+1 consume exactly 900/90/90 g.
- Vinjak: entry 40 ml stores 0.040 l for a litre ingredient; 25 separate actual payments from 1 l check every intermediate Decimal balance and end at exactly zero. First sale leaves 0.960 l; third leaves 0.880 l.
- Inventura: 10 → 9.4 → 9.7 kg creates exact -0.6/+0.3 corrections with actor, reference and audit; existing stale/parallel receipt/sale/double-confirm tests pass.
- Promoted recipe: 600 → 480 price, three units still consume 0.9 kg. Ownership handover and partial item transfer create no movements; transferred promotion snapshots survive. Split retry returns the original payment without additional deduction.
- Multi-round submit retry, real KDS advancement (`SUBMITTED → ACCEPTED → READY`, then pickup), full-payment retry and three receipt reprints create no extra SALE deductions.
- Draft 1→2→1 edits, draft removal and a partial submitted void leave two accepted sold servings: one -0.6 kg SALE movement, with no deduction before payment.
- Existing concurrent payments, direct-stock/ingredient atomic decrements and same-payment retries pass. Stock/ledger reconciliation races now have controlled database-lock regressions.

## Browser verification — synthetic/local, not physical PREPROD

Existing Chromium/CDP, esbuild and actual app components/CSS were used with synthetic APIs. No tool installation. Recipe, Inventory, raw-ingredient opening stock and Inventura detail were reviewed at **320/390/768/1440 px**; guided DirectStock also at 320 px. Final matrix had **no horizontal page overflow or runtime exceptions**.

Executed flows: RECIPE save and guided modal, add 300/30/30 and close/reopen, ingredient-removal application confirmation/cancel, Vinjak 40 ml, double-click add yields one request, unconfigured DIRECT_STOCK guided modal/save, NO_TRACKING no modal, raw opening stock review/confirmation, physical count entry/confirmation. Local screenshots/results: `.tmp/inventory-ui/` (ignored artifacts).

No accessible authenticated PREPROD browser session was present. **Authenticated PREPROD E2E: NOT EXECUTED. PHYSICALLY VERIFIED: NONE.** Synthetic requests do not prove live browser authorization or database persistence; the latter was verified separately in guarded DB tests.

Remaining design review findings: some existing Menu/Inventory/Ingredients controls and the DirectStock save button are below 44 px; assess on actual tablets. Unrelated Menu archive/delete native confirmations remain for later Design System work. These do not justify redesigning the app in this audit.

## PREPROD and database safety

Read-only inspection used the existing target resolver (`--env=preprod`), known endpoint `ep-solitary-leaf-b1q2002q`, DEVELOPMENT marker, and an explicit read-only transaction rolled back afterward. It confirmed Decimal(12,3) columns and the grants above. Observed counts: ingredients 21, finished-stock rows 138, ingredient-stock rows 0, ingredient movements 0, finished movements 258, count sessions 0. Physical raw-stock QA therefore needs a controlled setup.

No PREPROD seed, stock mutation, migration or reset was executed in this task. Deployment verification after the develop push is recorded in the final handoff. `main`, Production deployment and Production DB were untouched. All physical scenarios stay unchecked until the combined session records evidence.
