/** Structural sharing for JSON API snapshots, not an additional cache.
 * Compare every field so new server fields/statuses are never suppressed.
 * Used only after the existing read/availability safety gates accept a result.
 */
export function shareWaiterSnapshot<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const values = next.map((value, index) => shareWaiterSnapshot(previous[index], value));
    return (previous.length === values.length && values.every((value, index) => value === previous[index]) ? previous : values) as T;
  }
  if (Array.isArray(previous) || Array.isArray(next)) return next;
  const old = previous as Record<string, unknown>, incoming = next as Record<string, unknown>;
  const keys = Object.keys(incoming);
  let same = Object.keys(old).length === keys.length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = shareWaiterSnapshot(old[key], incoming[key]);
    if (!Object.prototype.hasOwnProperty.call(old, key) || result[key] !== old[key]) same = false;
  }
  return (same ? previous : result) as T;
}
