/**
 * Deterministički dokaz fail-closed mehanizma iz tests/setup/reset-test-db.ts
 * (docs/printing-validation-2026-09-09.md) — bez čekanja na sledeći slučajan
 * `DataFileImmediateSync` I/O zastoj. Umesto stvarnog TRUNCATE-a nad
 * fixture tabelama, simulira "zaglavljen" destruktivan upit preko
 * `SELECT pg_sleep(...)` na POSEBNOJ konekciji — isti kod put
 * (`runGuardedDestructiveStatement`) koji `resetPrismaTestTables`/
 * `resetPgTestTables` stvarno koriste, samo sa (a) namerno kratkim
 * injektovanim rokovima da test traje sekunde, ne minute, i (b)
 * injektovanim `onFatal`/`poisonFilePath` da NIKAD ne ugrozi/zaustavi sam
 * test runner niti dodirne pravi poison marker koji bi blokirao ostatak
 * suite-a.
 *
 * NAMERNO NIJE deo `tests/integration/print-*`/`settings`/
 * `multi-round-ordering` grupa koje apps/print-agent/Test-TableCore.mjs
 * bira (isolated/regression/combined) — ne menja postojeće očekivane
 * brojeve (22/47/69) iz validacione matrice. Pokreće se posebno:
 * `npx vitest run -c vitest.integration.config.ts tests/integration/reset-fail-closed.test.ts`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { runGuardedDestructiveStatement, type ResetGuardDeps } from "../setup/reset-test-db";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("[db-safety] TEST_DATABASE_URL nedostaje — require-test-database.ts je trebalo da abortuje run pre ovoga.");
}

// Skreč poison fajl PO TESTU — nikad deljeni DEFAULT_POISON_FILE iz
// reset-test-db.ts (taj bi, ako bi ga ovaj test upisao, blokirao SVE ostale
// integration fajlove u istom run-u).
const scratchDir = path.join(os.tmpdir(), `rcs-reset-fail-closed-${randomUUID()}`);
mkdirSync(scratchDir, { recursive: true });

function scratchPoisonFile(): string {
  return path.join(scratchDir, `poison-${randomUUID()}.json`);
}

async function openConn(): Promise<Client> {
  const client = new Client({ connectionString: testUrl });
  await client.connect();
  return client;
}

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("reset fail-closed harness — normal path", () => {
  it("a fast statement completes normally without ever calling onFatal", async () => {
    const conn = await openConn();
    const fatalCalls: string[] = [];
    const deps: ResetGuardDeps = {
      resetDeadlineMs: 5000,
      onFatal: (message) => fatalCalls.push(message),
      poisonFilePath: scratchPoisonFile(),
    };
    try {
      await runGuardedDestructiveStatement(conn, testUrl, "SELECT 1", deps);
      expect(fatalCalls).toEqual([]);
    } finally {
      await conn.end();
    }
  });
});

describe("reset fail-closed harness — deadline exceeded", () => {
  it("cancels/terminates EXACTLY the stuck backend, confirms it stopped, writes a poison marker, and calls onFatal instead of pretending success", async () => {
    const conn = await openConn();
    const fatalCalls: string[] = [];
    const poisonFilePath = scratchPoisonFile();
    const deps: ResetGuardDeps = {
      // pg_sleep(5) je namerno duže od ovog roka — deterministički simulira
      // "zaglavljen" destruktivan upit bez ijedne prave TRUNCATE/fixture zavisnosti.
      resetDeadlineMs: 300,
      cancelConfirmMs: 4000,
      terminateConfirmMs: 4000,
      pollIntervalMs: 100,
      onFatal: (message) => fatalCalls.push(message),
      poisonFilePath,
    };

    await runGuardedDestructiveStatement(conn, testUrl, "SELECT pg_sleep(5)", deps);

    // 1) onFatal MORA biti pozvan — reset PADA, nikad se ne pretvara da je uspeo.
    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0]).toContain("premašio");
    expect(fatalCalls[0]).toContain("300ms");

    // 2) Poison marker MORA postojati sa dokazom šta se desilo.
    expect(existsSync(poisonFilePath)).toBe(true);
    const marker = JSON.parse(readFileSync(poisonFilePath, "utf8")) as { backendPid: number; stopped: boolean; sql: string };
    expect(marker.sql).toBe("SELECT pg_sleep(5)");
    expect(marker.stopped).toBe(true); // pg_cancel_backend pouzdano prekida pg_sleep

    // 3) NEZAVISNA potvrda (ne verujemo samo modulovom "stopped" polju) — iz
    // OVOG testa, preko SVOJE konekcije, dokazujemo da backend koji je
    // izvršavao pg_sleep(5) VIŠE NE RADI taj upit. Ovo je direktan dokaz da
    // timeout ne može da ostavi "viseći" destruktivan rad u pozadini.
    const verify = await openConn();
    try {
      const { rows } = await verify.query<{ still_running: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE pid = $1 AND query = 'SELECT pg_sleep(5)' AND state = 'active'
         ) AS still_running`,
        [marker.backendPid]
      );
      expect(rows[0]?.still_running).toBe(false);
    } finally {
      await verify.end();
    }

    await conn.end().catch(() => {});
  });
});

describe("reset fail-closed harness — poisoned run refuses further destructive work", () => {
  it("refuses a subsequent reset attempt WITHOUT running any SQL once poisoned", async () => {
    const poisonFilePath = scratchPoisonFile();
    mkdirSync(path.dirname(poisonFilePath), { recursive: true });
    writeFileSync(poisonFilePath, JSON.stringify({ backendPid: 0, stopped: true, sql: "SELECT pg_sleep(5)", poisonedAt: new Date().toISOString() }));

    const fatalCalls: string[] = [];
    let queried = false;
    const spyConn = {
      query: async () => {
        queried = true;
        throw new Error("must never be called once poisoned");
      },
    };

    await runGuardedDestructiveStatement(spyConn, testUrl, "SELECT 1", {
      onFatal: (message) => fatalCalls.push(message),
      poisonFilePath,
    });

    expect(queried).toBe(false);
    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0]).toContain("otrovan");
  });
});
