export interface StationItemModifier {
  id: string;
  optionName: string;
  priceDelta: string;
}

export interface StationItem {
  id: string;
  name: string;
  quantity: number;
  note: string | null;
  status: "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  modifiers: StationItemModifier[];
  submittedAt: string | null;
  pending?: "saving" | "checking";
}

export interface StationOrder {
  orderId: string;
  tableLabel: string;
  waiterName: string;
  submittedAt: string | null;
  items: StationItem[];
}

export interface CompletedOrder extends StationOrder { completedAt: string }

export interface LocalTransition {
  orderId: string;
  status: StationItem["status"];
  pending?: StationItem["pending"];
  seq: number;
}

export const NEXT_STATUS_CLIENT: Partial<Record<StationItem["status"], StationItem["status"]>> = {
  SUBMITTED: "ACCEPTED", ACCEPTED: "READY", PREPARING: "READY",
};

export function isStationStatus(value: unknown): value is StationItem["status"] {
  return typeof value === "string" && ["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED", "CANCELLED"].includes(value);
}

export function hasPendingWork(order: StationOrder): boolean {
  return order.items.some(item => item.pending || ["SUBMITTED", "ACCEPTED", "PREPARING"].includes(item.status));
}

/** Pending writes survive every poll. Confirmed writes survive requests started
 * before confirmation, even when the ticket has already left the active list. */
export function mergeStationOrders(previous: StationOrder[], fresh: StationOrder[], writes: ReadonlyMap<string, LocalTransition>, pollSeq: number): StationOrder[] {
  const protectedWrite = (id: string) => {
    const write = writes.get(id);
    return write && (write.pending || write.seq > pollSeq) ? write : undefined;
  };
  const oldOrders = new Map(previous.map(order => [order.orderId, order]));
  const incoming = new Map(fresh.map(order => [order.orderId, order]));
  for (const order of previous) {
    if (!incoming.has(order.orderId) && order.items.some(item => protectedWrite(item.id))) {
      incoming.set(order.orderId, { ...order, items: [] });
    }
  }
  return [...incoming.values()].map(order => {
    const old = oldOrders.get(order.orderId);
    const oldItems = new Map(old?.items.map(item => [item.id, item]));
    const itemsById = new Map(order.items.map(item => [item.id, item]));
    for (const item of old?.items ?? []) {
      if (!itemsById.has(item.id) && protectedWrite(item.id)) itemsById.set(item.id, item);
    }
    const items = [...itemsById.values()].map(item => {
      const write = protectedWrite(item.id);
      const status = write?.status ?? item.status;
      const pending = write?.pending;
      const prev = oldItems.get(item.id);
      if (prev && prev.status === status && prev.pending === pending && prev.quantity === item.quantity &&
          prev.name === item.name && prev.note === item.note && prev.submittedAt === item.submittedAt &&
          JSON.stringify(prev.modifiers) === JSON.stringify(item.modifiers)) return prev;
      return { ...item, status, pending };
    });
    if (old && old.items.length === items.length && items.every((item, i) => item === old.items[i]) &&
        old.tableLabel === order.tableLabel && old.waiterName === order.waiterName && old.submittedAt === order.submittedAt) return old;
    return { ...order, items };
  }).filter(hasPendingWork);
}
