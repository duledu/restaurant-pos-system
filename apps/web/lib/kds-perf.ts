/**
 * PREPROD physical QA follow-up (Kitchen performance pass #2) — Part C/H.
 *
 * Proves, rather than assumes, whether an optimistic state update has
 * actually been PAINTED by the browser, and — only outside real
 * Production — reports the real tap→paint→API→reconcile timings so the
 * next physical device test yields measured evidence instead of another
 * guess. `React.useState` being called does NOT mean the user has seen
 * anything yet; the browser only paints after the current task yields and
 * the commit is flushed to the screen. The standard, setTimeout-free way
 * to detect "this has now actually been painted" is two chained
 * requestAnimationFrame calls: the first fires just before the browser's
 * next paint (i.e., for the frame that already contains our committed
 * update), the second fires in the FOLLOWING frame, which is only
 * possible once the first frame was actually presented.
 */

/** Resolves after the browser has painted at least one frame since this was called. */
export function nextPaint(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(performance.now()));
    });
  });
}

export interface KdsTapTiming {
  tapAt: number;
  optimisticStateAt: number;
  optimisticPaintAt: number;
  apiStartAt: number;
  apiEndAt: number;
  reconcileStateAt: number;
  reconcilePaintAt: number;
}

/**
 * Console-only, PREPROD/development-gated report — never Production, never
 * sent over the network, never persisted, no employee/order/PII content
 * (only relative millisecond offsets and a station/item id already visible
 * on screen). Trivial to disable: the caller decides whether to invoke
 * this at all (see KdsClient.tsx's `environmentLabel !== "PRODUKCIJA"`
 * gate) — removing the gate or this whole file removes the feature with
 * no other code paths depending on it.
 */
export function reportKdsTapTiming(label: string, t: KdsTapTiming): void {
  const fmt = (ms: number) => `${Math.max(0, ms - t.tapAt).toFixed(1)}ms`;
  // eslint-disable-next-line no-console
  console.info(
    `[KDS PERF] ${label} — tap→optimistic state: ${fmt(t.optimisticStateAt)} | tap→first paint: ${fmt(t.optimisticPaintAt)} | ` +
      `API: ${(t.apiEndAt - t.apiStartAt).toFixed(1)}ms | reconcile→paint: ${fmt(t.reconcilePaintAt)}`
  );
}
