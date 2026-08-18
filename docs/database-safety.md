# Database Safety Architecture

## The incident (August 2026)

Integration tests connected to the same Neon database as the running
development application. Every integration test file ran `TRUNCATE ...
CASCADE` (usually on `tenants`, which cascades through nearly the entire
tenant-scoped schema) in its `beforeEach`. `tests/setup/limit-db-connections.ts`
silently fell back to `TEST_DATABASE_URL = DATABASE_URL` whenever
`TEST_DATABASE_URL` was unset — and it was unset, because `.env` only ever
defined `DATABASE_URL`. Running the test suite deleted development users and
historical restaurant data. The documented recovery step was "run
`scripts/dev-repair-accounts.ts` after tests" — a repair, not a prevention.

## Root cause

A single silent fallback, three compounding gaps:

1. **The fallback itself**: `TEST_DATABASE_URL ??= DATABASE_URL` in the
   vitest setup file, plus a second, independent fallback hardcoded in 4
   test files that opened their own raw `pg.Client` (`process.env.TEST_DATABASE_URL
   ?? "postgresql://...localhost:5432/rcs_dev..."`).
2. **No identity check**: nothing compared `TEST_DATABASE_URL` against
   `DATABASE_URL`/`DIRECT_URL`, and nothing checked what the destination
   database actually *was* before truncating it.
3. **No architectural separation**: there was no dedicated, disposable TEST
   database — "DEV" and "the thing tests run against" were the same Neon
   branch by default.

## Architecture: three environments

| Environment | Purpose | Env var | Who connects |
|---|---|---|---|
| PRODUCTION | Real restaurant data | `DATABASE_URL`/`DIRECT_URL` (prod Neon branch) | Deployed app only |
| DEVELOPMENT | Manual dev/testing data | `DATABASE_URL`/`DIRECT_URL` (dev Neon branch, or local) | Developer running the app locally |
| TEST | Disposable, automated-test-only | `TEST_DATABASE_URL` | `vitest run -c vitest.integration.config.ts`, nothing else |

**Default TEST implementation**: a second, independent embedded Postgres
instance (`embedded-postgres`, already a project dependency used for the DEV
local flow), structurally separated from DEV on every axis:

| | DEV local | TEST local |
|---|---|---|
| Port | 55432 | 55433 |
| Database | `rcs_dev` | `rcs_test` |
| User | `rcs` | `rcs_test` |
| Data directory | `.local-postgres-data/` | `.local-postgres-data-test/` |

Different port + different data directory + different credentials means a
misconfiguration in any *one* of them still can't make `TEST_DATABASE_URL`
resolve to the DEV database — see `scripts/lib/local-test-db.mjs`.

`npm run test:integration` (`scripts/run-integration-tests.mjs`) starts this
instance, applies migrations, marks it (see below), runs
`tests/integration/**`, then tears it down — fully automatic, no setup
required. Nothing in this path ever reads `DATABASE_URL`.

**Alternative TEST implementations** (for environments where a spawned
Postgres process can't run — see "Known environment limitation" below, or a
deliberate choice to test against real Postgres-as-a-service):

- `docker/docker-compose.yml` now has a `postgres-test` service
  (port 55433, db `rcs_test`, no volume — always starts empty).
- A dedicated Neon "test" branch. Set `TEST_DATABASE_URL` in the environment
  (shell profile or CI secret) and run `npm run test:db:mark` once.

In both cases, `scripts/run-integration-tests.mjs` detects that
`TEST_DATABASE_URL` is already set and skips embedded provisioning — it
never overrides an explicitly-provided value.

## The safety gate

`tests/setup/require-test-database.ts` is the first `setupFiles` entry for
`vitest.integration.config.ts`. It runs `assertTestDatabaseIsSafe()`
(`tests/setup/assert-test-database.ts`) before any integration test file is
collected:

1. **`TEST_DATABASE_URL` must be set.** Missing → throws, which aborts the
   whole vitest run before any test executes. No fallback to `DATABASE_URL`
   exists anywhere in the codebase anymore.
2. **`TEST_DATABASE_URL` must not resolve to the same database as
   `DATABASE_URL` or `DIRECT_URL`** (compared by host+port+database name,
   ignoring credentials/query params — see `tests/setup/db-identity.ts`).
   Same database → abort. This is the literal check that would have caught
   the August 2026 incident.
3. **The database name must contain "test"** as a separate word
   (`rcs_test`, `test_db` — not `contest_data`, not `rcs_dev`).
4. **The database must carry a marker table** (`_rcs_test_database_marker`),
   written only by `scripts/lib/local-test-db.mjs` (embedded path) or
   `scripts/mark-test-database.ts` (external path). This is the "don't rely
   only on the env var name" defense-in-depth layer — a database only
   becomes eligible for `TRUNCATE` if something *deliberately* marked it,
   not merely because someone typed "test" into a connection string.

Only after all four checks pass does the gate set
`process.env.DATABASE_URL = process.env.DIRECT_URL = TEST_DATABASE_URL` for
the remainder of the process — this is what `@rcs/db`'s `PrismaClient` and
the 4 test files using a raw `pg.Client` actually connect to.

### Per-call defense in depth

Every integration test file used to call `TRUNCATE ... CASCADE` directly.
They now call `resetPrismaTestTables(prisma, tables)` or
`resetPgTestTables(client, tables)` (`tests/setup/reset-test-db.ts`), which
re-checks (cheaply, synchronously, no network round trip) that
`process.env.DATABASE_URL` still looks like a test database *immediately
before* every single `TRUNCATE` call — not just once at process start. This
catches the case where something later in the process reassigns
`DATABASE_URL`.

### Unit-tested, not just reviewed

`tests/unit/db-identity.test.ts` and `tests/unit/assert-test-database.test.ts`
exercise the gate's logic directly — missing env var, same-as-DEV,
same-as-DIRECT_URL, bad name pattern, unmarked database, and the success
path — without needing a live database connection (the marker check is
injected via a `connect` dependency for the unit tests). These are part of
the normal `npm run test:unit` run.

## Cascade / hard-delete audit

Every `onDelete` in `packages/db/prisma/schema.prisma`, cross-checked
against the actual `ON DELETE` clauses in
`packages/db/prisma/migrations/**/migration.sql` (the ground truth — Prisma
schema annotations and generated SQL can drift), and every `.delete(`/
`.deleteMany(` call in `packages/domain/**` and `apps/web/app/api/**`.

**Financial/history tables are already `RESTRICT`, not `CASCADE`**, at the
actual database level:

- `payments.orderId → orders.id`: `ON DELETE RESTRICT`
- `receipts.orderId → orders.id`, `receipts.paymentId → payments.id`: `RESTRICT`
- `payments.shiftId → shifts.id`: `RESTRICT`
- `order_item_voids.orderId/orderItemId/shiftId`: `RESTRICT`

**Weak/snapshot references are `SET NULL`** (deleting the referenced row
detaches the link but never removes the historical row):

- `employees.userId → users.id`
- `devices.employeeId → employees.id`
- `menu_items.categoryId → menu_categories.id`
- `order_items.menuItemId → menu_items.id`

`OrderItem`/`Receipt`/`OrderItemVoid` already store immutable snapshots
(`name`, `price`, `taxRate`, `waiterName`, `tableLabel`, ...) precisely so
that a later `SET NULL` never changes historical meaning — this was already
correct by design (see the comments at the top of `schema.prisma`).

**The only `CASCADE`s that exist** are join tables whose only purpose is the
link itself (`employee_locations`, `role_permissions`, `employee_roles`) and
`order_item_stations → order_items` (kitchen/bar per-station state, deleted
only alongside its own never-deleted-post-submission parent row). None of
these touch Payment/Receipt/Order history.

**Hard-delete call sites found** (`grep` across `packages/` and `apps/web/app/api/`):

| Call | File | Why it's safe |
|---|---|---|
| `tx.orderItem.delete(...)` | `packages/domain/orders/order-service.ts` (`removeItem`) | Only reachable while the order is still `DRAFT` — the item was never sent to kitchen/bar, so it isn't operational history yet. |
| `prisma.menuItem.delete(...)` | `packages/domain/menu/menu-service.ts` (`deleteMenuItem`) | `OrderItem` snapshots name/price; FK is `SET NULL`. `archiveMenuItem` (soft-delete via `deletedAt`) exists as the preferred path for items with order history. |
| `prisma.menuCategory.delete(...)` | `packages/domain/menu/menu-service.ts` (`deleteCategory`) | FK is `SET NULL` (items become uncategorized); requires explicit `force=true` confirmation if the category still has items. |
| `prisma.device.delete(...)` | *none found* — deactivation only sets `isActive: false` | No delete path exists yet; devices don't reference transactions at all. |

**No `employee.delete`, `order.delete`, `payment.delete`, `receipt.delete`,
`shift.delete`, or `orderItemVoid.delete` exists anywhere in the
application.** Employee/device "removal" is status-based (`setEmployeeStatus`
→ `SUSPENDED`/`TERMINATED`, device `isActive: false`), never a hard delete.

**No `TRUNCATE`, `DROP TABLE`, `prisma migrate reset`, or `db push
--force-reset`** exists in any `package.json` script or repository file
outside the test-only helpers described above. Production
build/start (`next build` / `next start`) never invokes migrations or seed
scripts.

**Conclusion: no schema or cascade changes were required.** The data model
was already built defensively (RESTRICT-by-default, snapshot fields,
SET NULL on weak references) — the incident was entirely a test-harness
problem, not a schema problem. No new migration was created.

## Reporting depends on snapshots, not live joins

`packages/domain/reporting/reporting-service.ts` already sources every
financial number from `Payment`/`Receipt` (and `OrderItem` snapshot fields),
never by re-joining current `MenuItem`/`Employee` rows — see the file's own
header comment. `getSalesByEmployee` resolves employee names via
`resolveEmployeeDisplayNames`, which does **not** filter by employee status,
so a `SUSPENDED` employee's historical name/role still resolves correctly.
`tests/integration/data-retention-safety.test.ts` now proves this
end-to-end (see below) rather than relying on code review alone.

## Automated safety tests

- `tests/unit/db-identity.test.ts` — pure connection-string comparison/name-pattern logic.
- `tests/unit/assert-test-database.test.ts` — the full gate decision tree (missing var, same-as-DEV, same-as-DIRECT_URL, bad name, unmarked db, success), no live DB needed.
- `tests/integration/data-retention-safety.test.ts`:
  - Suspending an employee doesn't delete their orders/payments; `getSalesSummary`/`getSalesByEmployee` still report them correctly.
  - Archiving a menu item doesn't delete order history; `getSoldItems` still counts it.
  - Hard-deleting a menu item leaves the `OrderItem` snapshot intact (`menuItemId` becomes `null`, not the row); `getSoldItems` still counts it.
  - Hard-deleting a device doesn't touch unrelated orders/payments.

## Neon backup/recovery recommendation

This session made no production changes and performed no restore — this is
a recommendation to adopt, not an action taken.

1. **Point-in-time recovery (PITR)**: Neon retains a history window per
   branch (length depends on plan). For accidental deletion/corruption,
   restore to a **new branch** created from a timestamp *before* the bad
   operation — never restore in place over the live branch.
2. **Verify on the recovery branch first**: point a throwaway
   `DATABASE_URL` at the new branch, run `npm run db:counts` and spot-check
   the affected rows/tables before doing anything else.
3. **Promote deliberately**: only after verification, either (a) reset the
   Neon connection string used by the app to the recovery branch, or (b)
   export the specific missing data from the recovery branch and
   re-insert it into the live branch — whichever has a smaller blast
   radius for the specific incident.
4. **Never restore by overwriting the live branch directly** — a bad
   restore compounds a bad deletion.
5. **Routine practice**: keep DEV on its own Neon branch (never PROD), and
   consider a scheduled logical dump (`pg_dump`) of PROD to external
   storage as a second, Neon-independent backup — Neon's own retention
   protects against accidental deletion, but not against a Neon-account-level
   incident.

## Known environment limitation (this session)

The full live "run the whole suite against the isolated TEST database, diff
DEV counts before/after" proof (item 9) could **not** be executed inside
this particular sandbox: the shell runs as Windows "Administrator", and
PostgreSQL's own Windows startup code unconditionally refuses to run the
server process under an administrative token ("Execution of PostgreSQL by a
user with administrative permissions is not permitted") — this is a
hard-coded Postgres safety check with no override flag, not a bug in this
architecture. The sandbox also has no Docker, no WSL2 (virtualization
disabled), and no pre-existing Postgres service to fall back to.

This does **not** affect normal developer machines (regular, non-admin
Windows accounts; any Linux/macOS shell) or typical CI runners, and the
newly-added `docker/docker-compose.yml` `postgres-test` service or a Neon
test branch (`npm run test:db:mark`) both sidestep this specific limitation
entirely by not spawning a Postgres process from this shell at all.

What *was* verified in this session, without a live TEST database:

- All 146 unit tests pass, including the gate's full decision tree
  (`tests/unit/assert-test-database.test.ts`), which directly exercises and
  confirms the abort behavior for every unsafe scenario.
- `npm run test:integration` fails **safely and loudly** in this sandbox
  (non-zero exit, the local Postgres never starts) rather than silently
  falling through to `DATABASE_URL` — DEV row counts were confirmed
  byte-for-byte identical (via `npm run db:counts`) before and after every
  attempt in this session.
- `npx tsc --noEmit` shows no new errors introduced by this work (the 8
  pre-existing errors are in `pin-login/route.ts`, `middleware.ts`, and
  `device-service.ts` — none touched this session — caused by a stale
  generated Prisma Client from an earlier commit; unrelated to database
  safety).

**Recommended next step**: run `npm run test` (or just `npm run
test:integration`) once on a normal developer machine or in CI to see the
full live proof — it is expected to auto-provision the embedded test
Postgres, run all 13+2 integration test files, and exit 0.
