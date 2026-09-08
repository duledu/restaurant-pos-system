/**
 * Centralizovan, tenant-bezbedan cache sloj (Redis, preko Upstash REST
 * klijenta — nikad TCP konekcija, vidi napomenu ispod zašto). Ovo je JEDINO
 * mesto u kodu koje sme da uvozi `@upstash/redis` — servisi (menu-service.ts,
 * settings-service.ts, ...) zovu ISKLJUČIVO get/set/del/getOrSet odavde,
 * nikad direktno Redis klijent (zahtev: "ne scatter-ovati Redis pozive kroz
 * desetine ruta").
 *
 * BEZBEDNOSNI PRINCIP (ne menjati bez ponovnog čitanja ovoga): PostgreSQL
 * ostaje jedini izvor istine. Redis ovde NIKAD ne baca grešku napolje — svaki
 * get/set/del interno hvata SVAKU grešku (mreža, loš token, Upstash pad) i
 * degradira na "kao da cache-a nema" (get->miss, set/del->no-op), tako da
 * pozivalac (getOrSet) UVEK padne nazad na `loader` (Postgres upit). Restoran
 * ne sme prestati da radi zato što je cache infrastruktura nedostupna.
 *
 * VERCEL SERVERLESS: TCP Redis klijent (npr. ioredis) otvara konekciju po
 * pozivu u serverless okruženju — isti problem koji je već dokumentovan u
 * packages/domain/realtime/sse-publisher.ts za in-memory EventEmitter (stanje
 * se ne deli između invokacija). Upstash REST klijent je bez-stanja HTTP poziv
 * po operaciji — nema konekciju da se otvori/zatvori/iscuri, pa je jedini
 * klijent koji stvarno odgovara ovom runtime-u.
 */
import { Redis } from "@upstash/redis";

const isDev = process.env.NODE_ENV === "development";

function devLog(action: string, key: string, extra?: string): void {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.debug(`[cache] ${action} ${key}${extra ? ` (${extra})` : ""}`);
}

/**
 * Namerno BEZ memoizacije klijenta na nivou modula — konstrukcija je jeftina
 * (REST klijent, nema I/O pri konstrukciji), a čitanje env promenljivih na
 * svaki poziv čini ponašanje predvidljivim po pozivu (i lako testabilnim bez
 * potrebe za reset-funkcijom između testova). `null` znači "Redis nije
 * konfigurisan" — trajno bezbedan no-op put, ne greška.
 */
function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Tenant-bezbedan graditelj ključeva — SVAKI cache ključ koji servisi prave
 * MORA proći kroz ovo, nikad ručno spajanje stringova, da restoran A
 * strukturno ne može pogoditi/napraviti ključ restorana B.
 */
export function buildCacheKey(restaurantId: string, ...parts: string[]): string {
  return `tablecore:restaurant:${restaurantId}:${parts.join(":")}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const value = await redis.get<T>(key);
    devLog(value === null || value === undefined ? "MISS" : "HIT", key);
    return value ?? null;
  } catch (err) {
    devLog("GET-ERROR", key, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
    devLog("SET", key, `ttl=${ttlSeconds}s`);
  } catch (err) {
    devLog("SET-ERROR", key, err instanceof Error ? err.message : String(err));
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(...keys);
    devLog("DEL", keys.join(", "));
  } catch (err) {
    devLog("DEL-ERROR", keys.join(", "), err instanceof Error ? err.message : String(err));
  }
}

/**
 * Glavni ulaz servisa: vrati keširanu vrednost ako postoji, u suprotnom
 * pozovi `loader` (Postgres) i (best-effort) upiši rezultat u keš. `loader`
 * se poziva TAČNO isto kao da cache-a uopšte nema — Redis nikad ne menja
 * poslovnu logiku, samo ubrzava ponovljeno čitanje.
 */
export async function getOrSet<T>(params: { key: string; ttlSeconds: number; loader: () => Promise<T> }): Promise<T> {
  const { key, ttlSeconds, loader } = params;
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  const start = isDev ? Date.now() : 0;
  const value = await loader();
  if (isDev) devLog("LOAD", key, `${Date.now() - start}ms from PostgreSQL`);

  await cacheSet(key, value, ttlSeconds);
  return value;
}
