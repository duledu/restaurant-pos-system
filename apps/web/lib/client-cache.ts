/**
 * Mali deljeni klijentski keš (P0/perf) — generalizacija ad hoc
 * module-scope TTL keša koji je već postojao za kategorije u
 * order-client.tsx. Namerno BEZ nove biblioteke (SWR/React Query) — obim je
 * uzak i ograničen (nekoliko session-stabilnih resursa: identitet
 * zaposlenog, kategorije, meni), ne opšta infrastruktura za paginaciju/
 * mutacije/optimistic UI.
 *
 * Stale-while-revalidate: rezultat unutar TTL-a se vraća odmah bez mrežnog
 * poziva; rezultat NAKON isteka TTL-a se I DALJE vraća odmah (da promena
 * ekrana nikad ne čeka), ali se u pozadini pokreće TAČNO JEDAN osvežavajući
 * poziv (in-flight mapa sprečava gomilanje duplih zahteva) čiji rezultat
 * postaje nova keširana vrednost za SLEDEĆI poziv.
 *
 * NAMERNO se NE koristi za bilo šta live/operativno (stanje stola, KDS red,
 * status zalihe) — samo za resurse koje audit izveštaj označava kao "C"
 * (retko menjano, admin-uređivano) referentne podatke.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

const isDev = process.env.NODE_ENV === "development";
function devLog(action: string, key: string): void {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.debug(`[client-cache] ${action} ${key}`);
}

export async function getOrFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as CacheEntry<T> | undefined;

  if (hit && hit.expiresAt > now) {
    devLog("HIT", key);
    return hit.value;
  }

  if (hit) {
    // Istekao, ali imamo vrednost — vrati je ODMAH, osveži u pozadini.
    devLog("STALE (serving old value, revalidating in background)", key);
    if (!inFlight.has(key)) {
      const refresh = fetcher()
        .then((fresh) => {
          store.set(key, { value: fresh, expiresAt: Date.now() + ttlMs });
          return fresh;
        })
        .catch(() => undefined)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, refresh);
    }
    return hit.value;
  }

  // Nema ništa keširano — mora se sačekati prvi odgovor. Dedupe-uje
  // konkurentne promašaje na isti ključ (npr. dve komponente montirane u
  // istom tiku) u JEDAN mrežni poziv.
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  devLog("MISS", key);
  const request = fetcher()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export function invalidateClientCache(key: string): void {
  store.delete(key);
  devLog("INVALIDATE", key);
}

export function clearClientCache(): void {
  store.clear();
  inFlight.clear();
}

/** Deljeni ključevi — JEDNO mesto da se izbegne neslaganje niski (typo)
 * između prefetch-a (posle login-a) i stvarnih potrošača (order-client.tsx,
 * pos-client.tsx, KdsClient.tsx). */
export const CLIENT_CACHE_KEYS = {
  me: "pos:me",
  categories: "pos:categories",
} as const;

export const CLIENT_CACHE_TTL_MS = 60_000;
