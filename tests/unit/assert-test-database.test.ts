import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertTestDatabaseIsSafe } from "../setup/assert-test-database";

// Dokazuje da je bezbednosna kapija (tests/setup/require-test-database.ts,
// učitana pre SVAKOG integration testa) zaista sposobna da ABORTUJE run —
// bez potrebe za pravom DB konekcijom, jer prve tri provere (env prisutan,
// nije ista baza kao DATABASE_URL/DIRECT_URL, ime sadrži "test") padaju
// pre nego što se bilo šta poveže na mrežu.

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of ["TEST_DATABASE_URL", "DATABASE_URL", "DIRECT_URL"]) {
    delete process.env[key];
  }
}

beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("assertTestDatabaseIsSafe", () => {
  it("aborts the run when TEST_DATABASE_URL is not set", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@ep-dev-pooler.neon.tech/rcs_dev?sslmode=require";

    await expect(assertTestDatabaseIsSafe()).rejects.toThrow(/TEST_DATABASE_URL nije postavljen/);
  });

  it("aborts the run when TEST_DATABASE_URL resolves to the same database as DATABASE_URL", async () => {
    process.env.DATABASE_URL = "postgresql://appuser:secret@ep-dev-pooler.neon.tech/rcs_dev?pgbouncer=true&sslmode=require";
    process.env.TEST_DATABASE_URL = "postgresql://otheruser:otherpw@ep-dev-pooler.neon.tech/rcs_dev?sslmode=require";

    await expect(assertTestDatabaseIsSafe()).rejects.toThrow(/ISTU bazu kao DATABASE_URL/);
  });

  it("aborts the run when TEST_DATABASE_URL resolves to the same database as DIRECT_URL", async () => {
    process.env.DIRECT_URL = "postgresql://u:p@ep-dev.neon.tech/rcs_dev?sslmode=require";
    process.env.TEST_DATABASE_URL = "postgresql://u:p@ep-dev.neon.tech/rcs_dev?sslmode=require";

    await expect(assertTestDatabaseIsSafe()).rejects.toThrow(/ISTU bazu kao DIRECT_URL/);
  });

  it("aborts the run when the target database name does not contain 'test'", async () => {
    process.env.TEST_DATABASE_URL = "postgresql://rcs:pw@127.0.0.1:55432/rcs_dev?schema=public";

    await expect(assertTestDatabaseIsSafe()).rejects.toThrow(/ne sadrži "test"/);
  });

  it("aborts when the database is not marked, and does NOT fall back to running destructive setup anyway", async () => {
    process.env.TEST_DATABASE_URL = "postgresql://rcs_test:pw@127.0.0.1:55433/rcs_test?schema=public";

    await expect(
      assertTestDatabaseIsSafe({ connect: async () => ({ marked: false }) })
    ).rejects.toThrow(/NIJE eksplicitno obeležena/);
  });

  it("passes and returns the verified URL once all checks succeed", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@ep-dev-pooler.neon.tech/rcs_dev?sslmode=require";
    process.env.TEST_DATABASE_URL = "postgresql://rcs_test:pw@127.0.0.1:55433/rcs_test?schema=public";

    const result = await assertTestDatabaseIsSafe({ connect: async () => ({ marked: true }) });
    expect(result).toBe(process.env.TEST_DATABASE_URL);
  });
});
