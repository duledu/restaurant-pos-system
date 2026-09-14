import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDatabaseTarget, DatabaseTargetError } from "../../scripts/lib/resolve-db-target.mjs";

// Regression coverage for the 2026-09-14 incident: `npx tsx
// packages/db/prisma/sync-permissions.ts` was meant to run against
// PREPROD but silently connected to PRODUCTION, because root `.env` holds
// the Production connection string, `.env.local` holds PREPROD, and
// @prisma/client's own internal env loading only ever reads `.env` — a
// separately-run verification script that explicitly loaded `.env.local`
// first proved nothing about what the actual write script would resolve.
// These tests never touch a real database — the live marker read is
// injected as a mock, and every hard-fail path is asserted to never even
// reach that call (proven with vi.fn() call assertions below).

const PROD_ENDPOINT = "ep-tiny-base-b1rj6246"; // real known-production id — used only inside local fixture files, never dialed
const DEV_ENDPOINT = "ep-solitary-leaf-b1q2002q"; // real known-development/PREPROD id — same reasoning
const TEST_ENDPOINT = "ep-steep-math-b1mu6kyv"; // real known-test id — same reasoning
const UNKNOWN_ENDPOINT = "ep-totally-unrecognized-zzz9999";

function fakeUrl(endpoint: string, { pooled = false } = {}) {
  const host = pooled ? `${endpoint}-pooler` : endpoint;
  return `postgresql://user:supersecretpassword@${host}.c-5.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require`;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "db-target-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnvFile(filename: string, vars: Record<string, string>) {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(path.join(dir, filename), body);
}

describe("resolveDatabaseTarget — CASE A: .env=Production, .env.local=PREPROD, requested=PREPROD, actual connection=Production => MUST BLOCK", () => {
  it("blocks before any write when .env.local itself has been pointed at the Production endpoint", async () => {
    // Simulates the exact incident layout: whatever .env.local (the PREPROD
    // file) actually resolves to is what must be validated — here it has
    // been misconfigured to the Production endpoint.
    writeEnvFile(".env", { DATABASE_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(PROD_ENDPOINT), DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }) });
    const readEnvironmentMarker = vi.fn();

    await expect(
      resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir, readEnvironmentMarker })
    ).rejects.toThrow(/DATABASE SAFETY VIOLATION\nRequested: PREPROD\nActual: PRODUCTION/);
    // Blocked by the static known-endpoint check — never even reaches the
    // live marker / network call.
    expect(readEnvironmentMarker).not.toHaveBeenCalled();
  });

  it("--env=preprod reads ONLY .env.local, even when .env sitting right next to it is Production (proves no cross-file leakage)", async () => {
    writeEnvFile(".env", { DATABASE_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }) });

    const readEnvironmentMarker = vi.fn().mockResolvedValue("DEVELOPMENT");
    const result = await resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir, readEnvironmentMarker });

    expect(result.endpointId).toBe(DEV_ENDPOINT);
    expect(result.envFile).toBe(".env.local");
    expect(readEnvironmentMarker).toHaveBeenCalledWith(expect.stringContaining(DEV_ENDPOINT));
    expect(readEnvironmentMarker).not.toHaveBeenCalledWith(expect.stringContaining(PROD_ENDPOINT));
  });
});

describe("resolveDatabaseTarget — CASE B: requested=PREPROD, actual marker=PREPROD => ALLOW", () => {
  it("succeeds and returns the PREPROD connection info", async () => {
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }) });
    const result = await resolveDatabaseTarget({
      argv: ["--env=preprod"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("DEVELOPMENT"),
    });
    expect(result.environment).toBe("preprod");
    expect(result.endpointId).toBe(DEV_ENDPOINT);
  });
});

describe("resolveDatabaseTarget — CASE C: requested=PRODUCTION, actual marker=PRODUCTION, no --confirm-production => BLOCK", () => {
  it("hard-fails BEFORE touching any file or the network", async () => {
    // repoRoot deliberately has no .env file at all — if the confirmation
    // check were not first, this would instead fail with a "file not
    // found" error, proving the ordering wrong.
    const readEnvironmentMarker = vi.fn();
    await expect(
      resolveDatabaseTarget({ argv: ["--env=production"], repoRoot: dir, readEnvironmentMarker })
    ).rejects.toThrow(/--confirm-production/);
    expect(readEnvironmentMarker).not.toHaveBeenCalled();
  });
});

describe("resolveDatabaseTarget — CASE D: requested=PRODUCTION, actual marker=PRODUCTION, with --confirm-production => may proceed", () => {
  it("succeeds and returns the Production connection info", async () => {
    writeEnvFile(".env", { DATABASE_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    const result = await resolveDatabaseTarget({
      argv: ["--env=production", "--confirm-production"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("PRODUCTION"),
    });
    expect(result.environment).toBe("production");
    expect(result.endpointId).toBe(PROD_ENDPOINT);
  });
});

describe("resolveDatabaseTarget — CASE E: requested=TEST, actual marker != TEST => BLOCK", () => {
  it("blocks when the .env.test-resolved database is not marked TEST", async () => {
    writeEnvFile(".env.test", { DATABASE_URL: fakeUrl(TEST_ENDPOINT), DIRECT_URL: fakeUrl(TEST_ENDPOINT, { pooled: true }) });
    await expect(
      resolveDatabaseTarget({
        argv: ["--env=test"],
        repoRoot: dir,
        readEnvironmentMarker: vi.fn().mockResolvedValue("DEVELOPMENT"),
      })
    ).rejects.toThrow(/DATABASE SAFETY VIOLATION\nRequested: TEST\nActual: PREPROD/);
  });

  it("succeeds when the .env.test-resolved database IS marked TEST", async () => {
    writeEnvFile(".env.test", { DATABASE_URL: fakeUrl(TEST_ENDPOINT), DIRECT_URL: fakeUrl(TEST_ENDPOINT, { pooled: true }) });
    const result = await resolveDatabaseTarget({
      argv: ["--env=test"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("TEST"),
    });
    expect(result.endpointId).toBe(TEST_ENDPOINT);
  });
});

describe("resolveDatabaseTarget — additional hard-fail guards", () => {
  it("refuses to guess when no --env flag is given", async () => {
    await expect(resolveDatabaseTarget({ argv: [], repoRoot: dir })).rejects.toThrow(DatabaseTargetError);
    await expect(resolveDatabaseTarget({ argv: [], repoRoot: dir })).rejects.toThrow(/No --env flag/);
  });

  it("rejects an unknown --env value", async () => {
    await expect(resolveDatabaseTarget({ argv: ["--env=staging"], repoRoot: dir })).rejects.toThrow(
      /Unknown --env=staging/
    );
  });

  it("--env=preprod hard-fails on an endpoint that is neither known Development, Production, nor Test", async () => {
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(UNKNOWN_ENDPOINT), DIRECT_URL: fakeUrl(UNKNOWN_ENDPOINT, { pooled: true }) });
    await expect(resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir })).rejects.toThrow(
      /not a known preprod endpoint/
    );
  });

  it("hard-fails when DATABASE_URL and DIRECT_URL resolve to different endpoints (one edited without the other)", async () => {
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    await expect(resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir })).rejects.toThrow(/don't match/);
  });

  it("hard-fails when the file is missing DATABASE_URL/DIRECT_URL", async () => {
    writeEnvFile(".env.local", { SOME_OTHER_VAR: "x" });
    await expect(resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir })).rejects.toThrow(
      /missing DATABASE_URL/
    );
  });

  it("hard-fails when the target is entirely unmarked (marker table missing/unreachable)", async () => {
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }) });
    await expect(
      resolveDatabaseTarget({ argv: ["--env=preprod"], repoRoot: dir, readEnvironmentMarker: vi.fn().mockResolvedValue(null) })
    ).rejects.toThrow(/Actual: UNMARKED/);
  });
});

describe("resolveDatabaseTarget — never leaks the raw connection string", () => {
  it("logs only a redacted host:port/db line, never the credentials", async () => {
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await resolveDatabaseTarget({
        argv: ["--env=preprod"],
        repoRoot: dir,
        readEnvironmentMarker: vi.fn().mockResolvedValue("DEVELOPMENT"),
      });
      const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("env=preprod");
      expect(printed).toContain(DEV_ENDPOINT);
      expect(printed).not.toContain("supersecretpassword");
    } finally {
      logSpy.mockRestore();
    }
  });
});
