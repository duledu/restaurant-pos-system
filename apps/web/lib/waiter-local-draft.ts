import { createWaiterCartMutations } from "./waiter-cart-mutations";
import { sameModifierSelection } from "./order-cart";
import { waiterTiming } from "./waiter-performance";
import type { MenuItem } from "./waiter-menu";
import type { OrderData, OrderItem } from "./waiter-order-types";

class RejectedAdd extends Error {}
async function request(url: string, method: string, body?: unknown) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) throw new RejectedAdd("Nije moguće dodati artikal. Pokušajte ponovo.");
    throw new Error("Veza je prekinuta. Pokušajte ponovo.");
  }
  return result;
}

type Creation = {
  tempId: string; mutationId: string; orderId: string; menuItemId: string;
  options: string[]; quantity: number; realItem: OrderItem | null; failed: boolean;
  requestStarted: () => void;
};

/** One table's in-memory draft, owned only by the mounted waiter shell.
 * Keeps requests and intent alive when the order route is temporarily absent.
 * Existing confirmed-line quantity/remove operations still use the same queue.
 */
export function createWaiterLocalDraft() {
  let snapshot: { order: OrderData | null; error: string | null; submitting: boolean } = { order: null, error: null, submitting: false };
  // Keep the existing Submit guard/key through navigation too; business rules
  // and key rotation remain in OrderClient's unchanged authoritative Submit.
  const submittingRef = { current: false };
  const submitRevision = { current: 0 };
  const idempotencyKeyRef = { current: crypto.randomUUID() };
  const listeners = new Set<() => void>();
  const mutations = createWaiterCartMutations();
  const creates = new Map<string, Creation>();
  const visibleTimings: Array<() => void> = [];
  const emit = () => { for (const listener of listeners) listener(); };
  const setError = (error: string | null) => { snapshot = { ...snapshot, error }; emit(); };
  const setSubmitting = (submitting: boolean) => { snapshot = { ...snapshot, submitting }; emit(); };
  const setOrder = (update: OrderData | null | ((previous: OrderData | null) => OrderData | null)) => {
    snapshot = { ...snapshot, order: typeof update === "function" ? update(snapshot.order) : update }; emit();
  };
  function patchLine(id: string, update: (item: OrderItem) => OrderItem | null) {
    setOrder(previous => previous ? { ...previous, items: previous.items.flatMap(item => item.id === id ? (update(item) ?? []) : item) } : previous);
  }
  function reconcileItem(serverOrder: OrderData, id: string) {
    // A failed confirmed-line mutation may need a GET, but that response must
    // never erase unrelated local creates waiting behind it in the queue.
    const authoritative = serverOrder.items.find(item => item.id === id);
    setOrder(previous => {
      if (!previous || previous.id !== serverOrder.id) return previous;
      if (!authoritative) return { ...previous, items: previous.items.filter(item => item.id !== id) };
      if (previous.items.some(item => item.id === id)) return { ...previous, items: previous.items.map(item => item.id === id ? authoritative : item) };
      const nextIds = new Set(serverOrder.items.slice(serverOrder.items.indexOf(authoritative) + 1).map(item => item.id));
      const index = previous.items.findIndex(item => nextIds.has(item.id));
      const items = [...previous.items]; items.splice(index < 0 ? items.length : index, 0, authoritative);
      return { ...previous, items };
    });
  }
  async function sendCreation(op: Creation) {
    op.requestStarted();
    const finishConfirmation = waiterTiming("add-confirmation");
    try {
      if (!op.realItem) {
        // A lost response is retried with the SAME immutable logical-add input.
        const body = { clientMutationId: op.mutationId, menuItemId: op.menuItemId, quantity: 1, modifierOptionIds: op.options };
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await request(`/api/pos/orders/${op.orderId}/items`, "POST", body);
            if (!result.item?.id) throw new Error("Nepotpun odgovor");
            op.realItem = result.item as OrderItem;
            break;
          } catch (error) { if (error instanceof RejectedAdd || attempt === 1) throw error; }
        }
      }
      // Keep the temp identity until all newer local intent has settled. This
      // lets +/- and remove continue targeting it while PATCH/DELETE is in flight.
      let serverQuantity = op.realItem.quantity;
      patchLine(op.tempId, current => ({ ...op.realItem!, id: op.tempId, quantity: current.quantity, localStatus: "pending" }));
      while (serverQuantity !== op.quantity) {
        const desired = op.quantity;
        if (desired === 0) {
          const itemId = op.realItem!.id;
          try {
            await request(`/api/pos/orders/${op.orderId}/items/${itemId}`, "DELETE");
          } catch (error) {
            // DELETE may also commit before its response is lost. Only on this
            // failure path, verify absence rather than leave an orphan/retry loop.
            const result = await request(`/api/pos/orders/${op.orderId}`, "GET");
            if (!result.order?.items || result.order.items.some((item: OrderItem) => item.id === itemId)) throw error;
          }
          creates.delete(op.tempId); finishConfirmation(); return;
        }
        const result = await request(`/api/pos/orders/${op.orderId}/items/${op.realItem!.id}`, "PATCH", { quantity: desired });
        serverQuantity = desired;
        if (result.item?.id) op.realItem = result.item;
      }
      patchLine(op.tempId, () => ({ ...op.realItem!, quantity: serverQuantity, localStatus: undefined }));
      creates.delete(op.tempId);
      finishConfirmation();
    } catch (error) {
      if (error instanceof RejectedAdd && !op.realItem) {
        // Definite server rejection: rollback this line, never the rest of cart.
        creates.delete(op.tempId); patchLine(op.tempId, () => null);
        setError(error.message);
      } else {
        // Unknown commit outcome must remain retryable, even if locally removed.
        op.failed = true;
        patchLine(op.tempId, item => ({ ...item, localStatus: "failed" }));
        setError("Izmena nije potvrđena. Proverite vezu i pokušajte ponovo.");
      }
      throw error;
    }
  }
  function add(menu: MenuItem, options: string[]): OrderItem | null {
    const localVisible = waiterTiming("add-local-visible");
    const requestStarted = waiterTiming("add-request-start");
    if (!snapshot.order || menu.availability?.isAvailable !== true) return null;
    const existing = snapshot.order.items.find(item => item.status === "DRAFT" && item.menuItemId === menu.id && sameModifierSelection(item.modifiers, options));
    if (existing) return existing;
    const mutationId = crypto.randomUUID();
    const tempId = `local:${mutationId}`;
    const selected = menu.modifierGroups.flatMap(({ group }) => group.options.filter(option => options.includes(option.id)).map(option => ({
      id: `local:${option.id}`, modifierOptionId: option.id, groupName: group.name, optionName: option.name, priceDelta: option.priceDelta,
    })));
    const price = (Number(menu.price) + selected.reduce((sum, option) => sum + Number(option.priceDelta), 0)).toFixed(2);
    const op: Creation = { tempId, mutationId, orderId: snapshot.order.id, menuItemId: menu.id, options: [...options], quantity: 1, realItem: null, failed: false,
      requestStarted };
    creates.set(tempId, op);
    visibleTimings.push(localVisible);
    setError(null);
    setOrder(previous => previous ? { ...previous, items: [...previous.items, { id: tempId, menuItemId: menu.id, name: menu.name, price, quantity: 1,
      note: null, status: "DRAFT", modifiers: selected, localStatus: "pending" }] } : previous);
    void mutations.enqueue(() => sendCreation(op)).catch(() => {});
    return null;
  }
  function changePending(id: string, quantity: number): boolean {
    const op = creates.get(id);
    if (!op) return false;
    if (quantity < 0 || quantity > 50) return true;
    op.quantity = quantity;
    visibleTimings.push(waiterTiming("quantity-local-visible"));
    patchLine(id, item => quantity === 0 ? null : { ...item, quantity });
    return true;
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot, setOrder, setError, mutations, add, changePending, reconcileItem,
    submittingRef, submitRevision, idempotencyKeyRef, setSubmitting,
    markVisible: () => { for (const finish of visibleTimings.splice(0)) finish(); },
    markQuantity: () => { visibleTimings.push(waiterTiming("quantity-local-visible")); },
    get pending() { return mutations.pending || creates.size > 0; },
    get retryable() { return [...creates.values()].some(op => op.failed); },
    retry: () => {
      mutations.acknowledgeFailure();
      setError(null);
      for (const op of creates.values()) if (op.failed) { op.failed = false; void mutations.enqueue(() => sendCreation(op)).catch(() => {}); }
    },
    flush: async (acknowledgeFailure = true) => {
      await mutations.flush(acknowledgeFailure);
      if (creates.size) throw new Error("Izmena nije potvrđena. Proverite vezu i pokušajte ponovo.");
    },
  };
}
export type WaiterLocalDraft = ReturnType<typeof createWaiterLocalDraft>;
