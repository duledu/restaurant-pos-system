/** Local request sequencing only; no order data, pricing, or submit rules. */
export function createWaiterCartMutations() {
  let tail: Promise<unknown> = Promise.resolve();
  let count = 0;
  let revision = 0;
  let failed = false;
  const scheduled = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    count++;
    revision++;
    const result = tail.then(action);
    tail = result.catch(() => { failed = true; }).finally(() => { count--; });
    return result;
  }
  function cancel(id: string) {
    const entry = scheduled.get(id);
    if (entry) { clearTimeout(entry.timer); scheduled.delete(id); revision++; }
  }
  function schedule(id: string, action: () => Promise<void>) {
    cancel(id);
    revision++;
    const run = () => { cancel(id); void enqueue(action).catch(() => {}); };
    scheduled.set(id, { timer: setTimeout(run, 350), run });
  }
  async function flush() {
    for (const entry of [...scheduled.values()]) entry.run();
    await tail;
    if (failed) {
      failed = false;
      throw new Error("Izmena porudžbine nije sačuvana. Proverite porudžbinu i pokušajte ponovo.");
    }
  }
  return { enqueue, schedule, cancel, flush,
    get pending() { return count > 0 || scheduled.size > 0; },
    get revision() { return revision; },
  };
}
