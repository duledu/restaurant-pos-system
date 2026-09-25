import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStudioTarget, buildStudioSpawnEnv, buildStudioArgs } from "../../scripts/db-studio.mjs";
import { DatabaseTargetError, resolveDatabaseTarget } from "../../scripts/lib/resolve-db-target.mjs";

// Prisma Studio is a full read/write GUI — the old `db:studio` npm script
// wrapped it with `dotenv -e .env --`, which resolved root `.env`
// (Production) by default, with zero confirmation. This wrapper
// (scripts/db-studio.mjs) must go through the exact same explicit-`--env`
// safety gate as every other write-capable script, BEFORE Prisma Studio is
// ever spawned. These tests exercise the wrapper's pure, testable pieces —
// resolveStudioTarget (delegates straight to resolveDatabaseTarget, so it
// inherits every guarantee already proven in resolve-db-target.test.ts) and
// buildStudioSpawnEnv (the environment actually handed to the child
// process) — without ever spawning a real `prisma studio` process.

const PROD_ENDPOINT = "ep-tiny-base-b1rj6246";
const DEV_ENDPOINT = "ep-solitary-leaf-b1q2002q";

function fakeUrl(endpoint: string, { pooled = false } = {}) {
  const host = pooled ? `${endpoint}-pooler` : endpoint;
  return `postgresql://user:supersecretpassword@${host}.c-5.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require`;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "db-studio-test-"));
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

describe("resolveStudioTarget — same safety gate as every other write-capable script", () => {
  it("refuses to guess when no --env flag is given (no default that silently opens Production)", async () => {
    await expect(resolveDatabaseTarget({ argv: [], repoRoot: dir })).rejects.toThrow(DatabaseTargetError);
  });

  it("--env=preprod resolves ONLY .env.local, never .env (Production) sitting next to it", async () => {
    writeEnvFile(".env", { DATABASE_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }), DIRECT_URL: fakeUrl(PROD_ENDPOINT) });
    writeEnvFile(".env.local", { DATABASE_URL: fakeUrl(DEV_ENDPOINT), DIRECT_URL: fakeUrl(DEV_ENDPOINT, { pooled: true }) });

    const target = await resolveDatabaseTarget({
      argv: ["--env=preprod"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("DEVELOPMENT"),
    });
    expect(target.endpointId).toBe(DEV_ENDPOINT);
  });

  it("--env=production without --confirm-production is refused before touching any file", async () => {
    const readEnvironmentMarker = vi.fn();
    await expect(
      resolveDatabaseTarget({ argv: ["--env=production"], repoRoot: dir, readEnvironmentMarker })
    ).rejects.toThrow(/--confirm-production/);
    expect(readEnvironmentMarker).not.toHaveBeenCalled();
  });

  it("--env=production WITH --confirm-production succeeds against a correctly-marked Production fixture", async () => {
    // PRODUCTION_DATABASE_URL is the DIRECT/non-pooler string,
    // PRODUCTION_DIRECT_URL is the POOLED one — inverted from their names,
    // verified against Neon (see resolve-db-target.mjs).
    writeEnvFile(".env", { PRODUCTION_DATABASE_URL: fakeUrl(PROD_ENDPOINT), PRODUCTION_DIRECT_URL: fakeUrl(PROD_ENDPOINT, { pooled: true }) });
    const target = await resolveDatabaseTarget({
      argv: ["--env=production", "--confirm-production"],
      repoRoot: dir,
      readEnvironmentMarker: vi.fn().mockResolvedValue("PRODUCTION"),
    });
    expect(target.endpointId).toBe(PROD_ENDPOINT);
  });
});

describe("buildStudioSpawnEnv", () => {
  it("overrides DATABASE_URL/DIRECT_URL from the resolved target, never from ambient env", () => {
    const target = {
      environment: "preprod" as const,
      databaseUrl: fakeUrl(DEV_ENDPOINT),
      directUrl: fakeUrl(DEV_ENDPOINT, { pooled: true }),
      endpointId: DEV_ENDPOINT,
      envFile: ".env.local",
    };
    const ambientEnv = { DATABASE_URL: fakeUrl(PROD_ENDPOINT), DIRECT_URL: fakeUrl(PROD_ENDPOINT), PATH: "/usr/bin" };

    const spawnEnv = buildStudioSpawnEnv(target, ambientEnv);

    expect(spawnEnv.DATABASE_URL).toBe(target.databaseUrl);
    expect(spawnEnv.DIRECT_URL).toBe(target.directUrl);
    expect(spawnEnv.DATABASE_URL).not.toContain(PROD_ENDPOINT);
    // Unrelated ambient vars are preserved (PATH etc. still needed for the child process).
    expect(spawnEnv.PATH).toBe("/usr/bin");
  });
});

describe("buildStudioArgs", () => {
  it("always launches against the repo's schema.prisma explicitly", () => {
    const args = buildStudioArgs();
    expect(args).toEqual(["prisma", "studio", "--schema", "packages/db/prisma/schema.prisma"]);
  });
});
