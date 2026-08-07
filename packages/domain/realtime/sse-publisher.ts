/**
 * MVP implementacija RealtimePublisher-a: in-memory EventEmitter, bez
 * Redis-a, jedna serverska instanca (vidi docs/01-RCS-Plan-v2-MVP.md, tačka
 * 1). Radi ispravno sa `next dev` / `next start` na jednom Node procesu ili
 * Docker kontejneru.
 *
 * VAŽNA NAPOMENA ZA VERCEL: Vercel Serverless Functions ne dele memoriju
 * između invokacija — ako se `order.created` obradi na jednoj instanci
 * funkcije, a SSE konekcija kuhinje živi na drugoj, događaj neće stići.
 * Ovo NIJE problem sada (lokalni razvoj, jedan proces), ali PRE produkcionog
 * Vercel deployment-a sa realnim saobraćajem, subscribe/publish ispod se
 * menja na redis-publisher.ts (Redis pub/sub) BEZ menjanja bilo kog
 * poziva u orders/production servisima — to je tačno razlog zašto postoji
 * RealtimePublisher interfejs. Za jednog restorana s malim brojem uređaja
 * na istoj lokaciji, Vercel obično drži toplu instancu dovoljno dugo da ovo
 * radi u praksi, ali garancija ne postoji na serverless platformi.
 */
import { EventEmitter } from "events";
import type { DomainEvent, RealtimePublisher } from "./publisher";

const emitter = new EventEmitter();
emitter.setMaxListeners(500); // više paralelnih SSE konekcija (POS/KDS/bar uređaji)

function channelKey(restaurantId: string, locationId?: string): string {
  return `${restaurantId}:${locationId ?? "*"}`;
}

export const ssePublisher: RealtimePublisher = {
  async publish(event: DomainEvent) {
    emitter.emit(channelKey(event.restaurantId, event.locationId), event);
    // Takođe emituj na "svi lokacija" kanal restorana, za owner dashboard
    // koji prati ceo restoran, ne jednu lokaciju.
    if (event.locationId) {
      emitter.emit(channelKey(event.restaurantId), event);
    }
  },
};

/**
 * Koristi SSE API ruta da se pretplati na događaje za svoj restoran/lokaciju
 * i (opciono) filtrira po ulozi. Vraća unsubscribe funkciju za cleanup kad
 * se konekcija zatvori.
 */
export function subscribe(
  restaurantId: string,
  locationId: string | undefined,
  role: string,
  onEvent: (event: DomainEvent) => void
): () => void {
  const handler = (event: DomainEvent) => {
    if (event.targetRoles && event.targetRoles.length > 0 && !event.targetRoles.includes(role)) {
      return;
    }
    onEvent(event);
  };
  const key = channelKey(restaurantId, locationId);
  emitter.on(key, handler);
  return () => emitter.off(key, handler);
}
