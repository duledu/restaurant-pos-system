# Kitchen/bar quick actions and waiter performance review

Baseline application: `0aa51f3ad62b7b11735225b195c8f12f391b7f7b`.
Local implementation only; no push, database operation, migration or environment change.

## A–E. Approved UI changes, classification, ranking and hydration

The mixed quick-action row is replaced by independent **KUHINJA** and **ŠANK**
horizontal scrollers, each capped at eight selections with existing 48px touch
targets. Empty stations render nothing. Existing favorite stars and +1 remain.
No unrelated header, search, category, menu card, typography, color, order panel,
total, navigation, or Submit styling changed.

Classification is the existing `MenuItem.preparationStation`, already returned
by `getWaiterMenuSnapshot` through `listMenuItems`. It is the menu routing field
snapshotted onto OrderItem and consumed by `stationsForPreparation` at Submit
to create KDS station rows. No category/name heuristic, schema field, manual
classification setting, or additional fetch was introduced.

Discovery-only tie rule: `KITCHEN_AND_BAR` appears once in KUHINJA. Its actual
production routing remains both stations. `NONE` and missing routing are omitted
from station suggestions rather than guessed. This rule does not restrict normal
menu ordering or repeat-round processing.

The existing `quickSuggestions` algorithm now accepts a station filter **before**
its cap. Recent table selections rank ahead of session favorites within each
station. Timestamp/quantity ordering and canonical modifier matching remain
unchanged. No unsupported global popularity fallback was invented. Current
prepared menu definitions/prices and shared live availability still validate each
selection, including another validation at tap time. There is no automatic add.
`repeatRound` remains one function over the complete latest submittedAt group,
including mixed stations, modifiers, quantities and partial-unavailability feedback.

Previously, cold inspection displayed disabled prepared menu cards before the
order identity/contents were available. Now only genuinely uninspected tables
show the table heading and a lightweight static status panel:
**Pripremamo sto i porudžbinu…**. No cards, categories, cart, or false empty total
are exposed during hydration. A failed inspection offers **Pokušaj ponovo** through
the same guarded read effect. There is no animation, minimum duration, new network
request, or timer. Successful hydration immediately reveals the existing screen.
Cached occupied and inspected-empty tables bypass this panel and revalidate in
the background. One table-owned snapshot and all read/mutation revision guards
remain unchanged. Retry state is only a UI attempt counter, not an order store.

## F. Bottlenecks ranked by waiter impact

- **CRITICAL:** no new unresolved correctness or critical performance regression
  established by the exercised fixture/tests. Real simultaneous-user and network
  behavior is not proven by this local review.
- **HIGH — cold network boundary:** one authoritative GET is still required for
  an uncached order. The fixture deliberately spends at least 200 ms in that API.
  The former sequential discovery/detail chain was not reintroduced. Removing
  premature menu mounting fixes the broken transition, not real network latency.
- **HIGH — Submit durable work:** order validation, price/availability/recipe
  checks, transactional station/event/audit writes, and post-commit PrintJob
  creation remain on the response path. Real stage timings are unavailable;
  assuming they are slow is insufficient justification for a lifecycle rewrite.
- **MEDIUM — slider renders:** the initial two-row implementation rendered both
  sliders on every +1 and station quick add in all three profiling sessions.
  Memoization removes those calls when displayed suggestions are unchanged.
- **MEDIUM — cached route mount:** reconstructing the view for an 80-row order
  remains real work; no parallel mounted-table cache was introduced. Existing
  table isolation and local-first snapshot reuse are preserved.
- **MEDIUM — polling latency:** tables poll every 5 seconds, order every 4 seconds,
  availability every 15 seconds while operational. KDS itself polls every 4
  seconds. READY detection therefore includes cadence, not only React cost.
- **LOW — derivation:** activeOrderView/tableMemory recompute on order updates;
  this predates the change. No evidence warrants a second derived-state cache.
  Existing indexed normal item lookup and memoized menu filtering remain.
- **LOW — shift summary navigation:** ShiftClient still reads identity, shift,
  then its financial summary sequentially. This lower-frequency close/report
  boundary was inspected but not timed live or rewritten using stale summaries.

## G–J. Network, rendering, shell and polling audit

Preparation: identity GET then four parallel GETs (menu snapshot containing
categories/prices/modifiers/routing, live availability, shift, tables/rooms).
There is one preparation per persistent tables shell. Login/PIN deliberately
skips the older reference prefetch for waiter redirects; it awaits authentication
then navigates/refreshes. No duplicate waiter menu prefetch was found.

Tables → occupied A → three adds → +1 → tables → B → A → Submit:
**8 → 8 operational requests**: three inspection GETs, three item POSTs, one
coalesced quantity PATCH, one Submit POST, plus cadence-dependent table polls.
**0 → 0 menu/category/modifier fetches during that navigation sequence.**
**1 → 1 read-only request for cold inspection.** No request removed: these are
required revalidation/mutation boundaries, not proven redundancy. Return to the
table list is local. Empty inspection never creates an order; explicit start
retains the existing creation transaction and detail authorization.

Fixture-only component call counters found MenuGrid, CategoryNavigation and
unrelated SubmittedRows already skip +1 and quick actions. The two new slider
components initially had **2 calls/action**; after memoization **0/action** when
the displayed selections remain the same. DraftRow still renders the changed
row. The comparator checks title, current menu reference, submitting state,
stable callback, ordered IDs, favorite badge and canonical modifier selection;
scores/timestamps are omitted because they do not render. Genuine rank, selection,
availability or menu changes still invalidate the row. No callback captures stale
order state: the existing committed-callback mechanism is reused.

Search retains its first-60-results progressive display, with access to all
matches. Categories remain uncapped. No images or new fonts were added; no heavy
animations or dependency were introduced. Room sections are all rendered in the
existing tables UI; there is no independent room-switch control to benchmark.

Shell data, favorites and per-table mutation controllers retain their existing
lifetime. Polls retain their in-flight protection and structural sharing.
No polling frequency or realtime architecture changed. Deltas/push notifications
may reduce READY detection delay and network traffic in a future measured phase;
they are not required to fix the measured unchanged-response render work.

Pickup retains its immediate local SERVED update, server request, rollback and
read hold. Lock/logout retain their authoritative requests and full session
navigation. Physical/authenticated timings for these paths are not inferred from
the fixture, which stubs auth controls and Next routing.

## K–M. Submit boundary and optimization decision

No Submit business or server code changed. The client immediately shows its busy
state, flushes pending mutations (including debounced quantity work), posts only
the idempotency key, and adopts the server response. The combined visible order
is never a request payload. There is no extra post-submit client GET.

On the server, the existing transaction selects only DRAFT IDs, refreshes pricing,
validates availability/recipe configuration, changes those IDs, creates their
station rows, records the order event and audit, then commits. Only afterward
does it publish the event, await station PrintJob dispatch, and return getOrder.
PrintJob dispatch uses the existing order/dispatch-key upsert and location lock.
No fire-and-forget continuation was introduced: it could lose job creation in a
serverless shutdown. Physical delivery is a separate existing agent/browser
lifecycle. A durable outbox would be a separate architectural change, not this task.

Submit timeline is unchanged in structure. Browser measurements below separately
report request-start delay, synthetic HTTP duration, and waiter-visible completion.
The fixture uses the same 200 ms API delay before/after and marks only its mock
drafts submitted; it is **not** a simulation of real durable storage or printers.
Server validation, DB work, durable commit, real response transport, KDS visibility,
PrintJob creation and PrintJob dispatch are **NOT MEASURED — no live database,
KDS or printer backend was exercised**. Queue flush is verified with delayed
responses in unit tests; the browser Submit sample has already-drained mutations,
so its request-start delay does not represent a weak-network backlog.

## O–T. Validation, scope and physical QA

- **471 unit tests / 51 files PASS**, zero failures. Includes **144 tests / 9
  waiter, READY, inspection and Submit-boundary files** (15 additions total).
- New coverage: routing including dual/NONE/missing, independent station caps,
  ranking/availability, mixed-station optimistic adds/repeat, absent station rows,
  cold retry, cached bypass, and real Submit service commit/dispatch/no-op boundaries
  with all DB/dispatch dependencies mocked. Two older tests were aligned with the
  explicitly changed cold-menu behavior; their category and isolation checks remain.
- Existing P0.3/P0.4/P0.5/P0.6/P0.6.1, READY, request-ordering, failed mutation,
  modifier, submitted+draft totals, reconciliation and Submit regressions pass.
- These mocks do not establish actual database concurrency or physical PrintJob
  deduplication under multiple processes. No destructive integration suite ran.
- TypeScript PASS. Production build PASS (131 pages; order route 10.4 kB,
  first-load JS 127 kB versus 9.98/126 previously). Diff check/review PASS.
- **Migration required: NO.** No schema, environment, database or production
  instrumentation changes. Performance counters exist only in the isolated
  benchmark transform; generated artifacts stay ignored under `.tmp`.

Changed files and purposes:

1. `apps/web/app/waiter/tables/[tableId]/order-client.tsx`: station sliders,
   memoized display boundary, cold hydration/retry only.
2. `apps/web/lib/waiter-menu.ts`: type the existing preparationStation field.
3. `apps/web/lib/waiter-table-memory.ts`: station filtering in existing ranking.
4. `scripts/performance/waiter-fixture.tsx`: mixed routing and synthetic Submit.
5. `scripts/performance/waiter-benchmark.mjs`: station taps, Submit/request trace,
   fixture-only component call counters.
6. `tests/unit/waiter-shell.test.ts`: mounted station/hydration regressions.
7. `tests/unit/waiter-table-memory.test.ts`: routing/ranking/mixed-round regressions.
8. `tests/unit/waiter-submit-boundary.test.ts`: mocked actual Submit service boundary.
9. `docs/waiter-kitchen-bar-performance.md`: this review and measurements.

Real-device QA remains required: Android phone/tablet input-to-paint latency,
independent touch scrolling, screen-reader announcement, cold visual transition
and layout movement, weak real Wi-Fi/retries, three simultaneous waiters and
20+ occupied tables, actual Next routing, authentication/lock/logout, KDS pickup
and visibility timing, physical printers/Print Agent. Synthetic Chrome at 4x CPU
is not Android evidence or a guarantee of a strict latency maximum.

Manual sequence: log in/prep → occupied A → check both station rows → tap each
→ repeat mixed round → verify only new drafts submit → return/reopen A → switch
A/B/A → change availability → check quick actions → open an uncached occupied
and empty table with slow Wi-Fi → verify clean hydration/no implicit create →
exercise failure/retry → READY/pickup → lock and sign in as another waiter.

## N. Final production-CSS paired measurements

Installed headless Chrome, 4x CPU slowdown, 412x915, 240 items / 12 categories, 24 tables / 80 submitted rows, synthetic 200 ms APIs. Three fresh-page sessions per side; sequential runs with no concurrent build/tests. Both sides use the same freshly built CSS. Baseline app comes from the revision above; fixture and counters are identical. These are noisy three-sample medians, not Android results. Local actions measure first React commit; cold actions measure first usable order/inspected-empty commit.

CSS fingerprints match: **true**. SHA-256: `c363bb786acd38d051fee02af090b4f79bb10b795d66239e293deb8db02962f5`. Raw runs stay in ignored `.tmp/waiter-stations-production`.

| SCREEN / ACTION | BEFORE ms | AFTER ms | IMPROVEMENT ms |
|---|---:|---:|---:|
| Preparation identity request → tables commit | 537.0 | 550.4 | -13.4 |
| Initial tables React render | 26.8 | 34.0 | -7.2 |
| occupied cold open | 326.0 | 276.1 | 49.9 |
| item add | 12.8 | 15.3 | -2.5 |
| rapid +1 | 11.6 | 10.2 | 1.4 |
| decrement | 3.8 | 6.0 | -2.2 |
| remove draft | 5.2 | 6.8 | -1.6 |
| category switch | 13.3 | 7.8 | 5.5 |
| search 240 results | 7.4 | 17.3 | -9.9 |
| clear search | 9.1 | 8.2 | 0.9 |
| modifier open | 2.7 | 8.0 | -5.3 |
| modifier confirm | 11.8 | 6.9 | 4.9 |
| quick +1 | 8.5 | 9.1 | -0.6 |
| Kitchen quick action | 7.5 | 5.0 | 2.5 |
| Bar quick action | 7.5 | 5.5 | 2.0 |
| repeat last round | 12.0 | 8.6 | 3.4 |
| back to tables | 11.5 | 10.5 | 1.0 |
| empty cold open | 254.7 | 254.9 | -0.2 |
| back from empty | 12.2 | 7.3 | 4.9 |
| cached reopen A | 36.9 | 38.6 | -1.7 |
| switch A to B | 11.5 | 5.4 | 6.1 |
| switch B to A | 23.4 | 29.0 | -5.6 |
| READY detection including polling | 552.6 | 972.0 | -419.4 |
| READY React work | 8.3 | 10.2 | -1.9 |
| Quiet 5.5s polling React work | 0.0 | 0.0 | 0.0 |
| Submit waiter-visible two-frame observation | 293.8 | 285.3 | 8.5 |
| Actual KDS visibility | NOT MEASURED — no live KDS backend | NOT MEASURED — same | — |
| PrintJob creation / physical dispatch | NOT MEASURED — no DB/printer | NOT MEASURED — same | — |
| Login/PIN, lock/logout | NOT MEASURED — auth and router stubbed | NOT MEASURED — same | — |
| Shift summary / close / print report | NOT MEASURED — financial backend excluded | NOT MEASURED — same | — |
| Room switching | NOT MEASURED — current UI renders room sections; no selector | NOT MEASURED — same | — |
| Pickup acknowledgement | NOT MEASURED — endpoint not in browser fixture; existing regression tests retained | NOT MEASURED — same | — |

Positive improvement means faster; negative means slower. No timing difference alone establishes causality from n=3. Kitchen/bar before values refer to the same items tapped in the old mixed row.

READY detection includes the phase of the unchanged 4s order / 5s table polls.
Its 419.4 ms median difference is not 419.4 ms of React work and is not evidence
that quick sliders blocked notifications. React work changed by 1.9 ms. The
earlier action durations alter when the fixture injects READY relative to polls.
Search, modifier-open, preparation and some navigation samples were slower;
all local-action medians remain below 50 ms. The results do not establish a
statistical speedup for every action. The concrete optimization evidence is the
slider render-call reduction; no extra refactor was made to chase timing noise.

Submit browser stages (same mock response contract, no server lifecycle optimization):

| Stage | BEFORE ms | AFTER ms |
|---|---:|---:|
| queueAndRequestStartMs | 16.1 | 9.9 |
| httpMs | 212.7 | 208.2 |
| waiterVisibleMs | 293.8 | 285.3 |

Cold occupied samples before: 439.9, 326.0, 288.3. After: 342.5, 256.4, 276.1. No hard maximum on actual devices is established.

Final local quantity/quick-action component calls per action (all sessions):

- rapid +1: [{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1}]
- Kitchen quick action: [{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1}]
- Bar quick action: [{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1},{"QuickActionSlider":0,"CategoryNavigation":0,"MenuGrid":0,"SubmittedRow":0,"DraftRow":1}]
