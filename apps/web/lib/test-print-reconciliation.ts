import type { PrintRouteType } from "@rcs/shared";

/**
 * PHYSICAL-QA FIX #1 — pure reconciliation helper extracted from the Admin
 * Test Print polling loop. Decides what to do next based on the latest
 * persisted state of `Workstation.testPrintStatus` +
 * `Workstation.testPrintRouteType` plus the route the operator actually
 * clicked and the time the operator's request was initiated.
 *
 * Three valid outcomes:
 *  - OPEN_MODAL  : the Agent has reported the technical test as
 *                  SUCCEEDED — surface the branded human confirmation
 *                  modal (the only authoritative event that may flip
 *                  `WorkstationPrintRoute.physicalTestConfirmed`).
 *  - SHOW_FAILURE : the Agent has reported FAILED — show the failure.
 *  - SHOW_TIMEOUT : the test is still pending, the polled status belongs
 *                  to a different route, the persisted `testPrintRequestedAt`
 *                  is older than the operator's current request, or no
 *                  status is available yet.
 *
 * ADMIN OBSERVATION WINDOW (FIX #1 v3):
 *   The Admin MUST observe the persisted state for at least the legitimate
 *   worst-case Agent pickup + Windows print + HTTP delivery cycle, with
 *   a reasonable buffer. The bounded bounds are documented in
 *   `apps/web/lib/test-print-observation.ts`. The hard cap exists so a
 *   genuinely stuck Agent (offline / service stopped / network down for
 *   hours) does not block the operator indefinitely — the timeline is:
 *
 *     Agent POLL pickup      ≤ 3s    (AgentRunner.ActivePollMs / MaxIdlePollMs)
 *     Agent HEARTBEAT pickup ≤ 25s   (AgentRunner.HeartbeatInterval)
 *     Windows test-print     ≤ ~10s  (network-share / slow thermal printer)
 *     HTTP delivery          ≤ 1s    (DeliveryClient.SubmitTestPrintResult)
 *     Buffer for transient   ≤ ~6s   (Agent transient stalls, small printer jams)
 *     ─────────────────────────────────
 *     TOTAL worst case       = 45s
 *
 *   This helper is the smallest testable expression of the reconciliation
 *   decision — it does not know about the loop deadline, only about the
 *   polled state. The loop in `test-print-observation.ts` is the
 *   separately-extracted orchestration that drives repeated calls to
 *   this helper inside the bounded observation window.
 *
 * Critical invariants enforced here so the Admin UI CANNOT accidentally:
 *  - Open a confirmation modal for a stale SUCCEEDED belonging to a
 *    DIFFERENT route (e.g., a parallel test triggered by a different
 *    Admin, or a historical test that was never confirmed).
 *  - Open a confirmation modal for a SUCCEEDED whose
 *    `testPrintRequestedAt` predates the operator's current request
 *    (older test, stale PENDING→SUCCEEDED row from before this click).
 *  - Open a confirmation modal when `testPrintStatus` is PENDING or null.
 *  - Skip the modal when the polled SUCCEEDED was for THE requested
 *    route AND was recorded for the CURRENT request, regardless of
 *    whether the polling loop's deadline elapsed.
 */

export type TestPrintStatus = "PENDING" | "SUCCEEDED" | "FAILED" | null;

export type ReconciliationDecision = "OPEN_MODAL" | "SHOW_FAILURE" | "SHOW_TIMEOUT";

/**
 * Small clock-skew tolerance between the Admin's `requestedAt` (browser
 * time at the moment of click) and the server-stamped
 * `testPrintRequestedAt` (DB timestamp). Both are wall-clock JS Date.now()
 * values; the round-trip is normally <100ms. 5s is comfortably above
 * any plausible clock drift between the operator's browser and the
 * TableCore server without being so loose that a same-day stale request
 * could be confused with a fresh one.
 */
export const STALE_REQUEST_BUFFER_MS = 5000;

export interface PollObservation {
  /** Latest `Workstation.testPrintStatus` value, or null if absent. */
  status: TestPrintStatus;
  /** Latest `Workstation.testPrintRouteType`, or null if absent. */
  routeType: PrintRouteType | null;
  /** Server-stamped `Workstation.testPrintRequestedAt` as ms since epoch, or null. */
  testPrintRequestedAtMs: number | null;
  /** Optional Agent-reported error message — surfaced on SHOW_FAILURE. */
  testPrintError?: string | null;
}

export function evaluateTestPollResult(
  polled: PollObservation,
  ourRequestedAtMs: number,
  requestedType: PrintRouteType,
): ReconciliationDecision {
  // Route-type matching: a SUCCEEDED belonging to a DIFFERENT route
  // (or no route) cannot open the modal for the requested route.
  // This guards against (a) parallel Admin tests on different routes,
  // (b) stale historical SUCCEEDED from a previous operator session,
  // and (c) malformed server rows where routeType is null.
  if (polled.routeType !== requestedType) return "SHOW_TIMEOUT";

  // Stale-result protection (FIX #1 v3): even if route types match,
  // the polled `testPrintRequestedAt` must NOT predate the operator's
  // current request (minus a small clock-skew buffer). An older SUCCEEDED
  // left on the row from before this click must not satisfy a new click
  // — the operator would otherwise see the modal pop up with stale
  // context from a previous request they did not make.
  if (polled.testPrintRequestedAtMs === null) return "SHOW_TIMEOUT";
  if (polled.testPrintRequestedAtMs < ourRequestedAtMs - STALE_REQUEST_BUFFER_MS) return "SHOW_TIMEOUT";

  if (polled.status === "SUCCEEDED") return "OPEN_MODAL";
  if (polled.status === "FAILED") return "SHOW_FAILURE";
  return "SHOW_TIMEOUT";
}
