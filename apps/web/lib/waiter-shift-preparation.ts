"use client";

import { waiterTiming } from "./waiter-performance";
import { useRef, useState } from "react";
import { readAvailability, type Category, type StaticMenuItem, type LiveAvailability } from "./waiter-menu";
import type { FloorWithTables } from "./waiter-tables";

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body as T;
}

export type PreparationStage = "identity" | "menu" | "availability" | "tables" | "ready";

/** Redosled u kom se poruke smisleno smenjuju — nezavisno od stvarnog
 * redosleda u kom se 4 paralelna poziva zaista završe (vidi recomputeStage
 * ispod). "tables" faza pokriva I stolove I smenu (jedna poruka za oba). */
const STAGE_SEQUENCE: PreparationStage[] = ["menu", "availability", "tables"];

export interface PreparationResult {
  restaurantId: string;
  firstName: string | null;
  lastName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  /** P0.3 — potrebno OrderClient-u (canVoid) da više ne mora sopstveni
   * /api/pos/me poziv samo za ovo. */
  roles: string[];
  locationId: string;
  shift: { id: string; status: string } | null;
  floors: FloorWithTables[];
  categories: Category[];
  /** Statički P0.1a snapshot artikli (cena/porez/dodaci) — BEZ live overlay-a. */
  items: StaticMenuItem[];
  /** Live overlay (stock/receptura/operativna dostupnost), ključ = menuItemId
   * — P0.2b: dobijen preko dedikovanog /api/pos/menu/availability endpointa
   * (zamenjuje P0.1b-ovo privremeno ponovno korišćenje /api/admin/menu/items). */
  availabilityByItemId: Map<string, LiveAvailability>;
  /** P0.2b — statička verzija menija (broj) ili `null` (Redis nedostupan/
   * nepoznato) pridružena OVOM konkretnom snapshot-u — vidi
   * menu.getWaiterMenuSnapshot. Još se ne koristi za rekonsilijaciju (to je
   * P0.2c/P0.3), samo je preneta ovde da bude dostupna kad zatreba. */
  menuVersion: number | null;
}

/**
 * P0.1b — Priprema smene (Instant Waiter Engine).
 *
 * Identitet/lokacija se MORA razrešiti prvo — sve ostalo zavisi od
 * locationId. To je JEDINA namerno sekvencijalna zavisnost. Posle toga sva
 * četiri poziva kreću ISTOVREMENO: statički meni snapshot (P0.1a), PRVA
 * autoritativna dostupnost, smena, stolovi.
 *
 * KRITIČNO PRAVILO ISPRAVNOSTI: konobar ne sme postati operativan dok prva
 * autoritativna dostupnost (stock/receptura/operativni blok po lokaciji)
 * nije poznata — zato se dostupnost poziva OVDE, kao deo pripreme, ne
 * odlaže za kasnije. Ako BILO KOJI od četiri poziva ne uspe, `Promise.all`
 * odbija i ova funkcija baca — poziv NIKAD ne vraća delimičan rezultat, pa
 * caller ne može pogrešno protumačiti "nepoznato" kao "dostupno".
 *
 * P0.2b: dostupnost se sada dobija preko DEDIKOVANOG
 * /api/pos/menu/availability endpointa (menu.getWaiterAvailabilityOverlay)
 * — malog live-overlay odgovora bez punih polja artikla, zamenjujući
 * P0.1b-ovo privremeno ponovno korišćenje /api/admin/menu/items. Ista
 * autoritativna logika iznutra (computeLiveOverlay), samo bez baznih
 * artikal polja koja duplirano putuju. Kategorije se NE preuzimaju posebno
 * — već su deo snapshot-a.
 */
export async function prepareShift(onStage: (stage: PreparationStage) => void): Promise<PreparationResult> {
  const finishTiming = waiterTiming("preparation");
  onStage("identity");
  const me = await apiFetch<{ restaurantId: string; employeeId: string; firstName: string | null; lastName: string | null; roles: string[]; locationIds: string[] }>("/api/pos/me");
  const locationId: string | undefined = me.locationIds?.[0];
  if (!locationId) throw new Error("Nalog nema dodeljenu lokaciju");

  const completed = new Set<"menu" | "availability" | "tables" | "shift">();
  function recomputeStage(): void {
    const tablesReady = completed.has("tables") && completed.has("shift");
    for (const stage of STAGE_SEQUENCE) {
      if (stage === "tables") {
        if (!tablesReady) return onStage("tables");
        continue;
      }
      if (!completed.has(stage as "menu" | "availability")) return onStage(stage);
    }
  }
  recomputeStage(); // odmah prikaži prvu poruku paralelnog bloka ("menu")

  function trackedFetch<T>(url: string, key: "menu" | "availability" | "tables" | "shift") {
    return apiFetch<T>(url).then((body) => {
      completed.add(key);
      recomputeStage();
      return body as T;
    });
  }

  const requests = [
    trackedFetch<Pick<PreparationResult, "restaurantId" | "locationId" | "categories" | "items" | "menuVersion">>(`/api/pos/menu/snapshot?locationId=${locationId}`, "menu"),
    trackedFetch<unknown>(`/api/pos/menu/availability?locationId=${locationId}`, "availability"),
    trackedFetch<{ shift: PreparationResult["shift"] }>(`/api/pos/shift?locationId=${locationId}`, "shift"),
    trackedFetch<{ floors: PreparationResult["floors"] }>(`/api/pos/tables?locationId=${locationId}`, "tables"),
  ] as const;
  // Drain sibling requests before exposing retry, so attempts never overlap.
  await Promise.allSettled(requests);
  const [snapshot, availability, shiftRes, tablesRes] = await Promise.all(requests);
  if (!me.restaurantId || snapshot.restaurantId !== me.restaurantId || snapshot.locationId !== locationId) throw new Error("Identitet nije usklađen");
  const availabilityByItemId = readAvailability(availability, locationId, snapshot.items);

  finishTiming();
  return {
    restaurantId: me.restaurantId,
    firstName: me.firstName ?? null,
    lastName: me.lastName ?? null,
    employeeId: me.employeeId ?? null,
    employeeName: me.firstName ? `${me.firstName} ${me.lastName ?? ""}`.trim() : null,
    roles: me.roles ?? [],
    locationId,
    shift: shiftRes.shift,
    floors: tablesRes.floors,
    categories: snapshot.categories,
    items: snapshot.items,
    availabilityByItemId,
    menuVersion: snapshot.menuVersion ?? null,
  };
}

export type PreparationUiState =
  | { status: "preparing"; stage: PreparationStage }
  | { status: "ready"; data: PreparationResult }
  | { status: "error"; message: string };

const PREPARATION_FAILURE_MESSAGE = "Ne možemo da završimo pripremu smene. Proverite vezu i pokušajte ponovo.";

/**
 * Čist, framework-nezavisan kontroler oko prepareShift (bez React-a) —
 * odvojen od useShiftPreparation ispod SAMO da bi guard protiv duplog
 * konkurentnog pokretanja (npr. brz dupli tap na "Pokušaj ponovo") mogao
 * da se testira direktno, bez React renderer-a (ovaj repo nema
 * @testing-library/react niti react-test-renderer, i ne uvodimo ih ovde
 * samo za jedan hook). Dok je priprema u toku, dodatni run() pozivi su
 * no-op — nikad dve konkurentne pripreme istovremeno.
 */
export function createShiftPreparationRunner(onState: (state: PreparationUiState) => void) {
  let running = false;
  function run(): void {
    if (running) return;
    running = true;
    onState({ status: "preparing", stage: "identity" });
    let acceptingStages = true;
    prepareShift((stage) => { if (acceptingStages) onState({ status: "preparing", stage }); })
      .then((data) => onState({ status: "ready", data }))
      .catch(() => { acceptingStages = false; onState({ status: "error", message: PREPARATION_FAILURE_MESSAGE }); })
      .finally(() => {
        running = false;
      });
  }
  return { run };
}

/** Tanak React hook oko createShiftPreparationRunner — jedino mesto koje
 * komponenta treba da pozove. */
export function useShiftPreparation() {
  const [state, setState] = useState<PreparationUiState>({ status: "preparing", stage: "identity" });
  const runnerRef = useRef<ReturnType<typeof createShiftPreparationRunner> | null>(null);
  runnerRef.current ??= createShiftPreparationRunner(setState);

  return { state, run: runnerRef.current.run };
}
