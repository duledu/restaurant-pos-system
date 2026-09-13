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

/**
 * Atomarni inkrement (Redis INCR) — jedina operacija ovde koja MENJA
 * brojčanu vrednost umesto da je zameni celu; koristi se za monotone
 * verzije (vidi menu-service.ts getMenuVersion/bumpMenuVersion, P0.2a).
 * INCR je atomaran NA SERVERU čak i preko bez-stanja REST poziva — Upstash
 * izvršava komandu kao jedan, nedeljiv upit, pa dva konkurentna poziva
 * NIKAD ne izgube inkrement (za razliku od read-then-write pristupa preko
 * cacheGet+cacheSet, koji bi imao stvarnu trku između dva konkurentna
 * admin uređivanja). Nepostojeći ključ se ponaša kao 0 pre inkrementa
 * (standardna Redis INCR semantika) — prvi bump vraća 1.
 *
 * Vraća `null` (NIKAD ne baca) ako Redis nije konfigurisan/dostupan —
 * pozivalac MORA tretirati `null` kao "verzija nepoznata/nepromenjena",
 * nikad kao razlog da cela poslovna mutacija (menu izmena) padne.
 */
export async function cacheIncr(key: string): Promise<number | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const next = await redis.incr(key);
    devLog("INCR", key, `-> ${next}`);
    return next;
  } catch (err) {
    devLog("INCR-ERROR", key, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Atomarno OBEZBEĐUJE da brojački ključ postoji, vraćajući NJEGOVU TRENUTNU
 * vrednost — 1 (ili `initialValue`) ako je OVAJ poziv taj koji ga je upravo
 * kreirao, ili već postojeću vrednost ako je neko drugi (konkurentan poziv,
 * ili ranija stvarna izmena) stigao prvi. NIKAD ne resetuje postojeći ključ
 * (zahtev P0.2a korekcije: "existing keys must never be reset").
 *
 * JEDAN atomaran poziv — Redis `SET key initialValue NX GET` (Redis 6.2+,
 * podržano preko Upstash REST-a): NX znači "postavi SAMO ako ključ ne
 * postoji", GET znači "vrati STARU vrednost pre ove komande" (uvek, bez
 * obzira da li je NX sprečio pisanje). Dva moguća ishoda, oba čitljiva iz
 * JEDNOG odgovora, bez ijednog dodatnog round-trip-a:
 *   - ključ NIJE postojao: NX upisuje `initialValue`, GET vraća `null`
 *     (nije bilo stare vrednosti) -> znamo da je trenutna vrednost sada
 *     `initialValue`.
 *   - ključ JE postojao: NX odbija upis, GET vraća POSTOJEĆU vrednost,
 *     NEPROMENJENU -> to je trenutna vrednost.
 * Namerno NIKAD read-then-write (cacheGet pa cacheSet) — to bi otvorilo
 * pravu trku između dva konkurentna poziva (oba bi mogla pročitati "ne
 * postoji" pre nego što ijedan upiše).
 *
 * Vraća `null` (NIKAD ne baca) ako Redis nije konfigurisan/dostupan —
 * pozivalac MORA tretirati to kao "verzija nepoznata", NIKAD kao da je
 * ključ stvarno inicijalizovan na neku vrednost.
 */
export async function cacheEnsureCounter(key: string, initialValue: number): Promise<number | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    // Tip komande (@upstash/redis) generički vraća `TData | "OK" | null` bez
    // obzira na opcije — "OK" se u praksi NIKAD ne vraća kad je `get: true`
    // prosleđeno (Redis SET ... GET uvek vraća STARU vrednost ili null, nikad
    // "OK"), ali defanzivno tretiramo bilo šta osim broja/null kao nepoznato
    // (nikad kao broj) da ne bismo slučajno vratili pogrešan tip pozivaocu.
    const previous = await redis.set<number>(key, initialValue, { nx: true, get: true });
    if (previous !== null && typeof previous !== "number") {
      devLog("ENSURE-ERROR", key, `unexpected SET GET reply: ${String(previous)}`);
      return null;
    }
    const current = previous ?? initialValue;
    devLog(previous === null ? "ENSURE-INIT" : "ENSURE-HIT", key, `-> ${current}`);
    return current;
  } catch (err) {
    devLog("ENSURE-ERROR", key, err instanceof Error ? err.message : String(err));
    return null;
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
 *
 * `fresh: true` (P0.2b — deo rešenja za "stale Redis posle version-triggered
 * refresh-a", vidi menu-service.ts getWaiterMenuSnapshot) PRESKAČE čitanje
 * keša (cacheGet se uopšte ne poziva) i UVEK ide na `loader`, ali i dalje
 * (best-effort) UPISUJE svež rezultat nazad u keš istim TTL-om — jedan
 * autoritativan poziv i ODMAH "leči" bilo koji zaostali stale unos za SVE
 * naredne obične (ne-fresh) pozive, umesto da se čeka isticanje TTL-a.
 * Podrazumevano `false` — postojeći pozivaoci ostaju potpuno nepromenjeni.
 */
export async function getOrSet<T>(params: { key: string; ttlSeconds: number; loader: () => Promise<T>; fresh?: boolean }): Promise<T> {
  const { key, ttlSeconds, loader, fresh } = params;
  if (!fresh) {
    const cached = await cacheGet<T>(key);
    if (cached !== null) return cached;
  }

  const start = isDev ? Date.now() : 0;
  const value = await loader();
  if (isDev) devLog(fresh ? "LOAD-FRESH" : "LOAD", key, `${Date.now() - start}ms from PostgreSQL`);

  await cacheSet(key, value, ttlSeconds);
  return value;
}
