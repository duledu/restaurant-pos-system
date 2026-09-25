import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDatabaseTarget, buildChildEnv, DatabaseTargetError } from "../../scripts/lib/resolve-db-target.mjs";

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
  it("succeeds and returns the Production connection info, reading ONLY PRODUCTION_DATABASE_URL/PRODUCTION_DIRECT_URL", async () => {
    // Plain DATABASE_URL/DIRECT_URL deliberately point elsewhere (the
    // developer's ordinary PREPROD session) — production resolution must
    // never read these for the production branch, only PRODUCTION_*.
    writeEnvFile(".env", {
      DATABASE_URL: fakeUrl(DEV_ENDPOINT),
      DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      // Real-world naming is inverted from role: PRODUCTION_DATABASE_URL is
      // the DIRECT/non-pooler string, PRODUCTION_DIRECT_URL is the POOLED one.
      PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT),
      PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    });
    const result = await resolveDatabaseTarget({
      argv: ["--env=production", "--confirm-production"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("PRODUCTION"),
    });
    expect(result.environment).toBe("production");
    expect(result.endpointId).toBe(PROD_ENDPOINT);
    // Pooled/direct roles corrected: DATABASE_URL must be the pooled string
    // (originally stored under PRODUCTION_DIRECT_URL), DIRECT_URL the
    // non-pooler string (originally stored under PRODUCTION_DATABASE_URL).
    expect(result.databaseUrl).toContain("-pooler");
    expect(result.directUrl).not.toContain("-pooler");
  });

  it("hard-fails when PRODUCTION_DATABASE_URL/PRODUCTION_DIRECT_URL are missing, even if plain DATABASE_URL/DIRECT_URL happen to be Production", async () => {
    writeEnvFile(".env", { DATABASE_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    const readEnvironmentMarker = vi.fn();
    await expect(
      resolveDatabaseTarget({ argv: ["--env=production", "--confirm-production"], repoRoot: dir, readEnvironmentMarker })
    ).rejects.toThrow(/missing PRODUCTION_DATABASE_URL/);
    expect(readEnvironmentMarker).not.toHaveBeenCalled();
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

  it("--env=production also never leaks the raw connection string", async () => {
    writeEnvFile(".env", {
      DATABASE_URL: fakeUrl(DEV_ENDPOINT),
      DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT),
      PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await resolveDatabaseTarget({
        argv: ["--env=production", "--confirm-production"],
        repoRoot: dir,
        readEnvironmentMarker: vi.fn().mockResolvedValue("PRODUCTION"),
      });
      const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("env=production");
      expect(printed).not.toContain("supersecretpassword");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// Objective 1 (Production release tooling hardening): PRODUCTION_DATABASE_URL/
// PRODUCTION_DIRECT_URL must be the ONLY source of Production credentials,
// .env.local must never be consulted for --env=production, and no helper
// may ever write back to .env/.env.local — only hand credentials to a
// spawned child process's OWN environment object.
describe("resolveDatabaseTarget — Production credential source is exclusively PRODUCTION_* (Objective 1 hardening)", () => {
  it("--env=production never reads .env.local, even when .env.local itself holds Production-looking values", async () => {
    writeEnvFile(".env", {
      DATABASE_URL: fakeUrl(DEV_ENDPOINT),
      DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT),
      PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    });
    // Deliberately absent/irrelevant — if production resolution ever fell
    // through to .env.local, this fixture would either crash on a missing
    // file (proving isolation) or, if it existed with different content,
    // silently succeed with the wrong endpoint (the actual regression this
    // guards against).
    const readEnvironmentMarker = vi.fn().mockResolvedValue("PRODUCTION");
    const result = await resolveDatabaseTarget({
      argv: ["--env=production", "--confirm-production"],
      repoRoot: dir,
      readEnvironmentMarker,
    });
    expect(result.envFile).toBe(".env");
    expect(result.endpointId).toBe(PROD_ENDPOINT);
  });

  it("--env=preprod never reads PRODUCTION_DATABASE_URL/PRODUCTION_DIRECT_URL even when they are present in .env.local", async () => {
    // Pathological fixture: someone pasted PRODUCTION_* into .env.local by
    // mistake. preprod resolution must still only ever use plain
    // DATABASE_URL/DIRECT_URL from .env.local.
    writeEnvFile(".env.local", {
      DATABASE_URL: fakeUrl(DEV_ENDPOINT),
      DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT),
      PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    });
    const result = await resolveDatabaseTarget({
      argv: ["--env=preprod"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("DEVELOPMENT"),
    });
    expect(result.endpointId).toBe(DEV_ENDPOINT);
  });

  it("resolveDatabaseTarget never writes to the .env file it just read (round-trip byte-for-byte)", async () => {
    writeEnvFile(".env", {
      DATABASE_URL: fakeUrl(DEV_ENDPOINT),
      DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT),
      PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    });
    const before = readFileSync(path.join(dir, ".env"), "utf8");
    await resolveDatabaseTarget({
      argv: ["--env=production", "--confirm-production"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("PRODUCTION"),
    });
    const after = readFileSync(path.join(dir, ".env"), "utf8");
    expect(after).toBe(before);
  });
});

describe("buildChildEnv — hands credentials to a child process only, never mutates the caller's own process.env", () => {
  const target = {
    environment: "production" as const,
    databaseUrl: fakeUrl(PROD_ENDPOINT, { pooled: true }),
    directUrl: fakeUrl(PROD_ENDPOINT),
    endpointId: PROD_ENDPOINT,
    envFile: ".env",
  };

  it("returns a NEW object with DATABASE_URL/DIRECT_URL from the target, overriding whatever the base env had", () => {
    const ambientEnv = { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }), PATH: "/usr/bin" };
    const childEnv = buildChildEnv(target, ambientEnv);

    expect(childEnv.DATABASE_URL).toBe(target.databaseUrl);
    expect(childEnv.DIRECT_URL).toBe(target.directUrl);
    expect(childEnv.DATABASE_URL).not.toContain(DEV_ENDPOINT);
    expect(childEnv.PATH).toBe("/usr/bin"); // unrelated ambient vars preserved for the child
    expect(ambientEnv).not.toBe(childEnv); // never the same object
  });

  it("never mutates the real process.env when called with the default base", () => {
    const before = { ...process.env };
    buildChildEnv(target);
    expect(process.env).toEqual(before);
  });
});
