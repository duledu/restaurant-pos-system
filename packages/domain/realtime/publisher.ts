/**
 * Domain servisi (orders, production, inventory...) zavise SAMO od ovog
 * interfejsa — nikad direktno od SSE koda. Vidi docs/01-RCS-Plan-v2-MVP.md,
 * tačka 6: MVP implementacija je in-memory SSE (sse-publisher.ts); kasnija
 * implementacija menja transport (Redis pub/sub za horizontalno
 * skaliranje) bez menjanja poziva u orders/production servisima.
 */

export interface DomainEvent {
  type: string; // "order.created", "order_item.status_changed", ...
  restaurantId: string;
  locationId?: string;
  targetRoles?: string[]; // ko sme da primi (npr. ["KITCHEN", "MANAGER"]); prazno = svi u restoranu/lokaciji
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface RealtimePublisher {
  publish(event: DomainEvent): Promise<void>;
}
