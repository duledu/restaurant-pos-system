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

No mutation/hydration/polling/Submit architecture was changed. Instead the
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
