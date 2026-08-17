import type { OrderItemStatus, PreparationStation, ProductionStation } from "@rcs/db";

const PROGRESS: OrderItemStatus[] = ["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"];

export function stationsForPreparation(station: PreparationStation): ProductionStation[] {
  switch (station) {
    case "KITCHEN":
      return ["KITCHEN"];
    case "BAR":
      return ["BAR"];
    case "KITCHEN_AND_BAR":
      return ["KITCHEN", "BAR"];
    case "NONE":
      return [];
  }
}

/**
 * OrderItem.status is a compatibility aggregate for waiter-facing screens.
 * It is the least-advanced required station. An item without production work
 * is SERVED after submission. KDS never reads or advances this aggregate.
 */
export function aggregateStationStatus(statuses: OrderItemStatus[]): OrderItemStatus {
  if (statuses.length === 0) return "SERVED";
  if (statuses.includes("CANCELLED")) return "CANCELLED";
  return statuses.reduce((leastAdvanced, status) =>
    PROGRESS.indexOf(status) < PROGRESS.indexOf(leastAdvanced) ? status : leastAdvanced
  );
}
