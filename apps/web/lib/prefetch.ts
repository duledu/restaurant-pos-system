/**
 * P0/perf — Faza 6 (prefetch): posle uspešne prijave/otključavanja, zagrej
 * klijentski keš za ograničen, unapred poznat skup referentnih podataka pre
 * nego što prvi POS ekran uopšte zatraži bilo šta. Namerno best-effort i
 * fire-and-forget — poziva se BEZ await-a odmah pre navigacije, tako da
 * spor/neuspeo prefetch NIKAD ne odloži niti obori prijavu. Ekrani koji
 * stvarno trebaju ove podatke (order-client.tsx, pos-client.tsx,
 * KdsClient.tsx) zovu ISTI getOrFetch sa ISTIM ključevima (CLIENT_CACHE_KEYS)
 * — topao pogodak ovde znači da njihov prvi poziv ne ide na mrežu uopšte;
 * neuspeh ovde je bezopasan, oni jednostavno sami dovuku podatak.
 *
 * Namerno SAMO me + kategorije — NIKAD stavke menija (koje nose live
 * zalihu/dostupnost po lokaciji, vidi order-client.tsx) niti bilo šta
 * istorijsko/veliko (izveštaji), tačno kako audit izveštaj (Faza 6) traži.
 */
import { getOrFetch, CLIENT_CACHE_KEYS, CLIENT_CACHE_TTL_MS } from "./client-cache";

async function apiFetch(url: string) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`Prefetch failed for ${url} (${res.status})`);
  return res.json();
}

export function prefetchPosReferenceData(): void {
  void (async () => {
    try {
      await Promise.all([
        getOrFetch(CLIENT_CACHE_KEYS.me, CLIENT_CACHE_TTL_MS, () => apiFetch("/api/pos/me")),
        getOrFetch(CLIENT_CACHE_KEYS.categories, CLIENT_CACHE_TTL_MS, () => apiFetch("/api/admin/menu/categories")),
      ]);
    } catch {
      // Best-effort zagrevanje keša — stvarni ekrani i dalje rade normalno
      // (samo bez toplog pogotka) ako ovo iz bilo kog razloga ne uspe.
    }
  })();
}
