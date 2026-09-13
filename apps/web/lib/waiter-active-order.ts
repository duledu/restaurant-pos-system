import type { OrderData } from "./waiter-order-types";

/** One display projection, never a mutation payload. IDs identify rows;
 * identical menu/modifier selections in different rounds remain distinct. */
export function activeOrderView(order: OrderData | null) {
  const uniqueItems = [...new Map((order?.items ?? []).map(item => [item.id, item])).values()];
  const activeItems = uniqueItems.filter(item => item.status !== "CANCELLED" && item.quantity > 0);
  const draftItems = activeItems.filter(item => item.status === "DRAFT");
  const sentItems = activeItems.filter(item => item.status !== "DRAFT");
  return {
    activeItems, draftItems, sentItems,
    historyItems: uniqueItems.filter(item => item.status !== "DRAFT"),
    readyItems: sentItems.filter(item => item.status === "READY"),
    hasEverSubmitted: uniqueItems.some(item => item.status !== "DRAFT") || Boolean(order && order.status !== "DRAFT"),
    count: activeItems.reduce((sum, item) => sum + item.quantity, 0),
    total: activeItems.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0),
  };
}
