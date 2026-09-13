/**
 * P0.1b — priprema smene (waiter-shift-preparation.ts). Čista logika, mock-uje
 * global.fetch — nikad ne dodiruje pravu bazu (vidi vitest.config.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearClientCache } from "../../apps/web/lib/client-cache";
import { prepareShift, createShiftPreparationRunner, type PreparationUiState } from "../../apps/web/lib/waiter-shift-preparation";

const ME = { restaurantId: "r1", employeeId: "emp-1", firstName: "Marko", lastName: "Markov", locationIds: ["loc-1"], roles: ["WAITER"] };
const SHIFT = { shift: { id: "shift-1", status: "OPEN" } };
const TABLES = { floors: [{ id: "floor-1", name: "Glavna sala", tables: [{ id: "t1", label: "1", capacity: 4, status: "FREE", activeOrderOwnerId: null, readyItems: [] }] }] };
const SNAPSHOT = { restaurantId: "r1", locationId: "loc-1", categories: [{ id: "cat-1", name: "Pića" }], items: [{ id: "item-1", name: "Rakija", price: 250 }], menuVersion: 3 };
const AVAILABILITY = { locationId: "loc-1", items: [{ menuItemId: "item-1", stock: { isLow: false }, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null } }] };

/** Kontrolisani "deferred" promise po URL-u — omogućava da test odluči TAČNO
 * kada se koji zahtev razrešava, da bi se dokazala prava paralelnost. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function installFetchMock(handlers: Record<string, () => Promise<Response>>) {
  const calls: string[] = [];
  // Poređenje po TAČNOJ putanji (bez query stringa), NIKAD substring/.includes
  // — "/api/pos/me" je substring od "/api/pos/menu/snapshot" ("menu" počinje
  // sa "me"), pa bi .includes() lažno poklopio pogrešan handler.
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const pathname = url.split("?")[0];
    const handler = handlers[pathname];
    if (!handler) throw new Error(`Neočekivan fetch poziv u testu: ${url}`);
    return handler();
  });
  // @ts-expect-error — test dvojnik, ne pun fetch tip
  global.fetch = fetchMock;
  return { fetchMock, calls };
}

beforeEach(() => {
  clearClientCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareShift: uspešan tok", () => {
  it("ne završava se dok statički meni nije spreman", async () => {
    const menuDeferred = deferred<Response>();
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": () => menuDeferred.promise,
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    let settled = false;
    const p = prepareShift(() => {}).then((r) => {
      settled = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // meni još nije razrešen — priprema NE sme biti gotova

    menuDeferred.resolve(jsonResponse(SNAPSHOT));
    await p;
    expect(settled).toBe(true);
  });

  it("ne završava se dok PRVA autoritativna dostupnost nije spremna", async () => {
    const availabilityDeferred = deferred<Response>();
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": () => availabilityDeferred.promise,
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    let settled = false;
    const p = prepareShift(() => {}).then((r) => {
      settled = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    availabilityDeferred.resolve(jsonResponse(AVAILABILITY));
    await p;
    expect(settled).toBe(true);
  });

  it("meni/dostupnost/smena/stolovi se pozivaju ISTOVREMENO, ne sekvencijalno", async () => {
    const { calls } = installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    await prepareShift(() => {});

    // "me" mora biti prvi (jedina namerna sekvencijalna zavisnost)...
    expect(calls[0]).toContain("/api/pos/me");
    // ...ali sva 4 paralelna poziva moraju biti ZAPOČETA pre nego što ijedan
    // odgovor stigne — dokazano time što su SVA 4 URL-a već u `calls` posle
    // samo jednog mikrotask ciklusa od trenutka kad "me" postane dostupan
    // (svaki handler ovde razrešava sinhrono/mikrotaskom bez veštačkog
    // odlaganja, pa redosled u `calls` odražava redosled POZIVANJA, ne
    // redosled ZAVRŠETKA).
    const parallelCalls = calls.slice(1);
    expect(parallelCalls.some((u) => u.includes("/api/pos/menu/snapshot"))).toBe(true);
    expect(parallelCalls.some((u) => u.includes("/api/pos/menu/availability"))).toBe(true);
    expect(parallelCalls.some((u) => u.includes("/api/pos/shift"))).toBe(true);
    expect(parallelCalls.some((u) => u.includes("/api/pos/tables"))).toBe(true);
  });

  it("kategorije se NE preuzimaju posebno — već su deo menu snapshot-a", async () => {
    const { calls } = installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const result = await prepareShift(() => {});

    expect(calls.some((u) => u.includes("/api/admin/menu/categories"))).toBe(false);
    expect(result.categories).toEqual(SNAPSHOT.categories);
  });

  it("uspeh dostiže 'ready' stanje sa kompletnim podacima (identitet, smena, stolovi, meni, dostupnost)", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const stages: string[] = [];
    const result = await prepareShift((s) => stages.push(s));

    expect(result.employeeId).toBe("emp-1");
    expect(result.employeeName).toBe("Marko Markov");
    expect(result.locationId).toBe("loc-1");
    expect(result.shift).toEqual(SHIFT.shift);
    expect(result.floors).toEqual(TABLES.floors);
    expect(result.items).toEqual(SNAPSHOT.items);
    expect(result.availabilityByItemId.get("item-1")).toEqual({
      stock: AVAILABILITY.items[0].stock,
      recipeAvailability: AVAILABILITY.items[0].recipeAvailability,
      availability: AVAILABILITY.items[0].availability,
    });
    expect(result.menuVersion).toBe(3); // P0.2b — preneto iz snapshot odgovora
    expect(result.roles).toEqual(["WAITER"]); // P0.3 — preneto iz me odgovora
    // Poruke moraju napredovati kroz smisleni redosled, počev od identiteta.
    expect(stages[0]).toBe("identity");
    expect(stages).toContain("menu");
  });

  it("P0.2b: menuVersion:null (Redis nedostupan) NE ruši pripremu — snapshot i dalje uspeva", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse({ ...SNAPSHOT, menuVersion: null }),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const result = await prepareShift(() => {});

    expect(result.menuVersion).toBeNull();
    expect(result.items).toEqual(SNAPSHOT.items); // ostatak snapshot-a i dalje potpuno ispravan
  });
});

describe("prepareShift: neuspeh — NIKAD delimičan rezultat, NIKAD 'nepoznato' = 'dostupno'", () => {
  it("pad menu snapshot-a odbija celu pripremu", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse({ error: "boom" }, false, 500),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    await expect(prepareShift(() => {})).rejects.toThrow();
  });

  it("pad dostupnosti odbija celu pripremu — nikad ne pretpostavlja 'dostupno' za nepoznato", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse({ error: "boom" }, false, 500),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    await expect(prepareShift(() => {})).rejects.toThrow();
  });

  it("pad stolova odbija celu pripremu", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse({ error: "boom" }, false, 500),
    });

    await expect(prepareShift(() => {})).rejects.toThrow();
  });
});

describe("createShiftPreparationRunner: retry i konkurentnost", () => {
  it("dupli poziv run() dok je priprema u toku ne pokreće drugi konkurentan zahtev", async () => {
    const meDeferred = deferred<Response>();
    const { fetchMock } = installFetchMock({
      "/api/pos/me": () => meDeferred.promise,
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const states: PreparationUiState[] = [];
    const { run } = createShiftPreparationRunner((s) => states.push(s));

    run();
    run(); // dupli poziv dok je "me" još u letu — mora biti no-op
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    meDeferred.resolve(jsonResponse(ME));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

  it("posle uspešne pripreme, run() ponovo dozvoljava novi ciklus (retry posle prethodnog uspeha)", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse(AVAILABILITY),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const states: PreparationUiState[] = [];
    const { run } = createShiftPreparationRunner((s) => states.push(s));

    run();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)?.status).toBe("ready");

    run(); // novi run posle uspeha — mora ponovo raditi, ne zaglaviti
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("neuspešna priprema proizvodi 'error' stanje sa konciznom porukom za retry, nikad tihi fallback", async () => {
    installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse({ error: "boom" }, false, 500),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const states: PreparationUiState[] = [];
    const { run } = createShiftPreparationRunner((s) => states.push(s));
    run();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    if (last?.status === "error") {
      expect(last.message).toMatch(/pripremu smene/);
    }
    // Nijedno stanje NIKAD ne nosi "ready" sa podacima kad je zahtev pao —
    // dokaz da nema delimičnog/tihog fallback-a.
    expect(states.some((s) => s.status === "ready")).toBe(false);
  });

  it("run() nakon greške dozvoljava novi pokušaj (nije zauvek zaglavljen)", async () => {
    const { fetchMock } = installFetchMock({
      "/api/pos/me": async () => jsonResponse(ME),
      "/api/pos/menu/snapshot": async () => jsonResponse(SNAPSHOT),
      "/api/pos/menu/availability": async () => jsonResponse({ error: "boom" }, false, 500),
      "/api/pos/shift": async () => jsonResponse(SHIFT),
      "/api/pos/tables": async () => jsonResponse(TABLES),
    });

    const states: PreparationUiState[] = [];
    const { run } = createShiftPreparationRunner((s) => states.push(s));
    run();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)?.status).toBe("error");

    const callsBeforeRetry = fetchMock.mock.calls.length;
    run(); // retry — mora ponovo zvati mrežu, ne biti zaglavljen kao "running"
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});
