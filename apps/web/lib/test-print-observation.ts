import { evaluateTestPollResult, type PollObservation, type ReconciliationDecision } from "./test-print-reconciliation";
import { evaluateTestPollResult as _reeval } from "./test-print-reconciliation";
import type { PrintRouteType } from "@rcs/shared";

/**
 * PHYSICAL-QA FIX #1 v3 — Admin-side observation lifecycle for the
 * authoritative Agent-driven test print.
 *
 * The Admin MUST observe the persisted state for at least the legitimate
 * worst-case Agent pickup + Windows print + HTTP delivery cycle, with a
 * reasonable buffer. The bounded bounds come from the actual Agent and
 * server timing constants (see comments below for the proof).
 *
 * The observation window is computed from documented timing constants,
 * not from an arbitrary round number:
 *
 *   Agent POLL pickup      ≤ 3s    (AgentRunner.ActivePollMs / MaxIdlePollMs)
 *   Agent HEARTBEAT pickup ≤ 25s   (AgentRunner.HeartbeatInterval)
 *   Windows test-print     ≤ ~10s  (network-share / slow thermal printer)
 *   HTTP delivery          ≤ 1s    (DeliveryClient.SubmitTestPrintResult)
 *   Buffer for transient   ≤ ~6s   (Agent transient stalls, small printer jams)
 *   ─────────────────────────────────
 *   TOTAL worst case       = 45s   ← OBSERVATION_WINDOW_MS
 *
 *   Anything beyond 45s means the Agent is genuinely stuck (offline,
 *   service stopped, network down for many minutes, printer hardware
 *   failure). At that point SHOW_TIMEOUT is the correct outcome so the
 *   operator is informed rather than blocked indefinitely; the operator
 *   can press "Testiraj" again later when the underlying condition is
 *   resolved.
 *
 * Why this is a separate function (not inlined in `WorkstationsPanel`):
 *   - The polling loop is the *only* piece of timing-sensitive logic in
 *     the Admin's test-print lifecycle. Extracting it makes the timing
 *     contract explicit, testable, and impossible to accidentally widen
 *     or narrow in a future refactor.
 *   - All time / fetch / sleep primitives are injectable so the
 *     vitest suite can drive the loop deterministically without
 *     actually sleeping for 45 seconds (see FIX #1 v3 tests).
 *   - The React component (`WorkstationsPanel.testPrint()`) is a thin
 *     shell that wires this function to real `apiFetch` / `Date.now()` /
 *     `setTimeout()` — no React Testing Library required.
 *
 * v4 UPDATE — also exports the small `extractWorkstationObservation`
 * helper so the imperative observation fetcher and any future consumer
 * (Admin banner, Admin diagnostic panel, regression test) derive the
 * SAME PollObservation from the SAME workstation row. This pins the
 * shape of the data the reconciliation helper receives, eliminating the
 * class of bug where the observation could read stale data while the
 * banner correctly shows SUCCEEDED.
 */

export const OBSERVATION_WINDOW_MS = 45_000;
export const POLL_INTERVAL_MS = 1500;

export interface ObservationClock {
  /** Returns the current wall-clock time as ms since epoch. */
  now(): number;
  /** Async sleep for the given milliseconds. */
  sleep(ms: number): Promise<void>;
}

export interface ObservationFetcher {
  /**
   * Fetch the current workstation state. Returns null if the workstation
   * row is unreachable for any reason (network blip, Admin session
   * expired, etc.) so the caller can distinguish a missing poll from a
   * PENDING-with-empty-fields poll.
   */
  (): Promise<PollObservation | null>;
}

export interface ObserveOptions {
  observationWindowMs?: number;
  pollIntervalMs?: number;
  clock: ObservationClock;
  fetcher: ObservationFetcher;
  /**
   * FIX_1_V4_TEMP_DIAG — optional per-poll callback so callers can log
   * the exact PollObservation and decision the loop evaluated at each
   * step. Pure side-effect observation — the returned outcome is
   * unchanged.
   */
  onPoll?: (polled: PollObservation, decision: ReconciliationDecision) => void;
}

export interface ObserveOutcome {
  decision: ReconciliationDecision;
  polls: number;
  elapsedMs: number;
  /** The last polled value the loop evaluated (null if every fetch returned null). */
  lastPolled: PollObservation | null;
  /**
   * Whether the loop exited because of a non-TIMEOUT decision
   * (`true`) or because the observation window elapsed (`false`).
   * Useful for tests; matches the user's "did the lifecycle reach
   * the human confirmation step" question.
   */
  resolvedEarly: boolean;
}

export async function observeTestPrintLifecycle(
  ourRequestedAtMs: number,
  requestedType: PrintRouteType,
  options: ObserveOptions,
): Promise<ObserveOutcome> {
  const window = options.observationWindowMs ?? OBSERVATION_WINDOW_MS;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const { now, sleep } = options.clock;
  const fetcher = options.fetcher;

  const startedAtMs = now();
  const deadline = ourRequestedAtMs + window;
  let polls = 0;
  let elapsedMs = 0;
  let lastPolled: PollObservation | null = null;

  while (now() < deadline) {
    await sleep(interval);
    elapsedMs += interval;
    const fetched = await fetcher();
    polls++;
    lastPolled = fetched;
    const polled: PollObservation = fetched ?? {
      status: null,
      routeType: null,
      testPrintRequestedAtMs: null,
    };
    const decision = evaluateTestPollResult(polled, ourRequestedAtMs, requestedType);
    options.onPoll?.(polled, decision);
    if (decision !== "SHOW_TIMEOUT") {
      return { decision, polls, elapsedMs, lastPolled: polled, resolvedEarly: true };
    }
  }

  // Defense-in-depth re-read (FIX #1 v2): one final authoritative fetch
  // RIGHT AT the observation window boundary, so a SUCCEEDED that arrived
  // during the last `sleep(interval)` cannot be silently dropped. The
  // observation window is the primary mechanism; this is just a safety
  // net for a poll-and-arrive-in-the-same-millisecond edge case.
  const finalFetched = await fetcher();
  polls++;
  lastPolled = finalFetched;
  const finalPolled: PollObservation = finalFetched ?? {
    status: null,
    routeType: null,
    testPrintRequestedAtMs: null,
  };
  const finalDecision = _reeval(finalPolled, ourRequestedAtMs, requestedType);
  options.onPoll?.(finalPolled, finalDecision);
  void startedAtMs;
  return { decision: finalDecision, polls, elapsedMs, lastPolled: finalPolled, resolvedEarly: false };
}

// ── v4 EXTRACTION HELPER ────────────────────────────────────────────────
// SMALLEST shared fetch/extraction helper so the observation fetcher and
// any future caller (Admin banner, Admin diagnostic panel, tests) all
// derive the SAME PollObservation from the SAME fresh API response. The
// v4 diagnosis required this so the regression test can pin the exact
// data shape the reconciliation helper receives, eliminating the class
// of bug where the observation could read stale data while the banner
// correctly shows SUCCEEDED.

/**
 * The minimal shape needed from a workstation row to drive a single
 * reconciliation decision. This is a SUBSET of the Workstation row the
 * `/api/admin/workstations` endpoint returns — only the fields the
 * observation fetcher actually reads.
 */
export interface WorkstationObservationSource {
  testPrintStatus: "PENDING" | "SUCCEEDED" | "FAILED" | null;
  testPrintRouteType: PrintRouteType | null;
  testPrintRequestedAt: string | Date | number | null;
  testPrintCompletedAt?: string | Date | number | null;
  testPrintError?: string | null;
}

/**
 * Extract the PollObservation from a fresh workstation response row.
 * Returns `null` for every field when the source carries nothing useful
 * (so the caller treats it as a non-event — same as the imperative
 * fetcher's null-fallback behaviour).
 *
 * Critical invariants this helper enforces (the v4 regression test pins
 * each one against the EXACT same fields the imperative fetcher reads):
 *  - `status` is `null` if absent — NOT coerced to a string.
 *  - `routeType` is `null` if absent.
 *  - `testPrintRequestedAtMs`:
 *      • `null` if absent,
 *      • `null` if not parseable as a Date (NaN),
 *      • `ms since epoch` otherwise.
 */
export function extractWorkstationObservation(ws: WorkstationObservationSource | null | undefined): PollObservation {
  if (!ws) {
    return { status: null, routeType: null, testPrintRequestedAtMs: null };
  }
  const requestedAt = parseTimestampToMs(ws.testPrintRequestedAt);
  return {
    status: ws.testPrintStatus ?? null,
    routeType: (ws.testPrintRouteType as PrintRouteType | null) ?? null,
    testPrintRequestedAtMs: requestedAt,
    testPrintError: ws.testPrintError ?? null,
  };
}

function parseTimestampToMs(value: string | Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}
