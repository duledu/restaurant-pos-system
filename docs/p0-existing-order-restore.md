# P0: complete active order in the waiter bottom panel

## Reproduction and cause

Mounted OrderClient with an authoritative order containing two Coffee and one
Omlet (700 RSD), all already submitted/served. The shell retained both server
rows, but the fixed bottom panel showed zero items and 0.00 RSD. Ten new
regressions failed before the fix while all 36 existing mounted tests passed.
This proves a presentation projection bug, not loss of server rows in the
optimistic store. The live mobile Table 1 response was not inspected; the
reported wording "Nema stavki još" also depends on aggregate order status.

Previously the bottom panel's rows, count and total were filtered to DRAFT.
Submitted rows were only rendered in a separate history section above the
menu. The panel therefore appeared to lose the order after Submit/reopening.
That history section was also gated solely by order.status, rather than the
actual presence of submitted items.

## Lifecycle audit

- Table route keys TableOrderClient by tableId; shell stores one draft per table.
- POST openOrder returns the existing non-completed/non-cancelled order;
  subsequent GET getOrder includes all item statuses and modifiers.
- Local draft starts with order=null, not a synthetic empty order. Hydration
  installs the complete GET snapshot. The initial waiting view does not render
  a zero cart while order is null.
- Add appends a temporary DRAFT row to existing order.items. Matching is limited
  to DRAFT plus canonical modifier identity. Reconciliation replaces only the
  targeted temporary row. Quantity/remove reconciliation targets one row.
- Polls and initial reads spanning mutations/Submit are rejected by existing
  revision/pending guards. Shell state survives child navigation.
- P0.5 memory derives from this same order and inputs the P0.4 add handler.
- Submit flushes that same queue and installs the complete server response.
  Server processing selects DRAFT items and scopes KDS/printing to that round.

The initial fix did not change mutation/hydration/polling/Submit architecture. The
bottom panel now represents all positive-quantity non-CANCELLED rows, rendering
submitted rows read-only (status, modifiers, notes, price) and DRAFT rows with
the existing edit controls. Count/total use each active row once. Item history
also establishes that submission has occurred even if aggregate status differs.
The panel keeps its existing bounded scrolling layout for large orders.

## Validation and retest

14 regressions cover server hydration, reopen, navigation, optimistic add,
quantity +1, P0.5 chip, polling/availability, late polling response, Submit and
reopen after Submit, table isolation, cancelled totals, aggregate status mismatch,
failure/retry with the same mutation ID, and READY item status with pending work.
Full unit suite: 429 tests / 47 files. P0.3/P0.4/P0.5 suites and READY pass.
Typecheck passes. No migration or database operation is required.

Device retest: reopen occupied Table 1 with 2 Coca-Cola + 1 Omlet. The bottom
panel must show all three units and their total. Add Cedevita while throttled;
expect four units immediately, only Cedevita editable/new. Submit, return to
tables, reopen: all four units remain and Submit is disabled until another
draft is added. Switch to another table and back; verify table isolation.
Existing sent rows remain read-only; no client call resubmits them as new rows.

## Final architecture review

Three further races were reproduced in mounted tests after the initial fix:

1. A slow reopen GET could overwrite a newer polling snapshot because both
   had the same mutation revision. Responses lacked a shared ordering guard.
2. If a local edit invalidated a reopen GET while the cached order was DRAFT,
   polling was disabled and another waiter's new submitted round stayed hidden.
3. A READY poll started before pickup confirmation could return afterward and
   overwrite the optimistic/reconciled SERVED state.

The table-owned P0.4 controller now owns a read sequence shared by hydration
and polling across route mounts. A full-order read is accepted only if it is
the newest started read, spans no cart mutation or Submit, and no unresolved
create or status-update hold exists. Initial hydration captures its read stamp
after flushing known mutations. Existing pickup and void calls hold read
acceptance through reconciliation; their endpoints/business rules are unchanged.
Polling continues for open DRAFT orders as well as submitted orders, at the
existing four-second cadence, only on the mounted table. Reads skipped while
mutations are pending resume on a later polling tick. Network failures retain
the last known order; unresolved creates still require the existing retry path.
This is eventual server freshness after writes settle, not realtime/offline
cross-device synchronization or a claim that unavailable data can be displayed.

`activeOrderView` is the single derived display contract. It deduplicates by
OrderItem ID, excludes CANCELLED/zero-quantity rows, and derives active submitted
rows, editable DRAFT rows, READY rows, count and total from that same set.
Table-memory suggestions use its submitted set; favorites intentionally use
session history with current menu/availability validation. Cancelled history
can still appear in the separate audit/history section but contributes nothing
to the active panel/count/total. The two UI sections are views of one store.

Count is the sum of quantities (not distinct lines). Total is the sum of
effective unit price times desired visible quantity, including submitted rows
and optimistic drafts; this is an order subtotal, not remaining balance due.
Submitted prices are server snapshots. Pending draft prices are previews until
server confirmation. Pending deletion removes a row immediately; rejection
reconciliation can restore it. Modifier-inclusive prices are not added twice.
Different rounds remain separate even when menu/modifier selections match.

Temporary IDs stay stable until POST and newer quantity/removal intent settle.
The immutable clientMutationId remains the retry key. Only then does the
targeted temp row become its server row; complete refresh is blocked during
ambiguous creates to avoid representing the same operation twice. No parallel
submitted cache, second cart, server schema or Submit payload was introduced.

Nine additional tests protect these races, projection/deduplication, pending
removal, Submit read boundaries, and 3 isolated waiter sets of 24 table sessions
with 80 rows each. This is deterministic simulation, not a live restaurant
load test. Full validation: 438 unit tests across 48 files; waiter/READY subset
111 tests across 6 files. No web research or database tests were needed.
