// Environment-targeted Prisma Studio launcher — the same explicit-`--env`
// safety layer as scripts/lib/resolve-db-target.mjs, applied to Studio.
//
// WHY THIS EXISTS: the old `db:studio` npm script wrapped `prisma studio`
// with `dotenv -e .env --`, which resolves root `.env` — the Production
// connection string — by default. Prisma Studio is a full read/write GUI:
// a casual `npm run db:studio` opened a live editor onto Production data
// with zero confirmation. This wrapper resolves and validates the target
// via resolveDatabaseTarget() BEFORE ever spawning Prisma Studio, and
// launches it with an explicitly-constructed environment (never inheriting
// whatever ambient DATABASE_URL/DIRECT_URL happened to already be set).
//
// Run:
//   npm run db:test:studio
//   npm run db:preprod:studio
//   npm run db:production:studio -- --confirm-production
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDatabaseTarget } from "./lib/resolve-db-target.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Resolves and validates the Studio target. Exported for tests. */
export async function resolveStudioTarget(argv = process.argv.slice(2)) {
  return resolveDatabaseTarget({ argv });
}

/**
 * Builds the exact env object Prisma Studio's child process will see —
 * DATABASE_URL/DIRECT_URL come ONLY from the validated target, never from
 * whatever the caller's ambient environment already had. Exported for
 * tests (pure function, no process spawned).
 */
export function buildStudioSpawnEnv(target, baseEnv = process.env) {
  return { ...baseEnv, DATABASE_URL: target.databaseUrl, DIRECT_URL: target.directUrl };
}

/** Builds the prisma CLI argv for Studio. Exported for tests. */
export function buildStudioArgs() {
  return ["prisma", "studio", "--schema", "packages/db/prisma/schema.prisma"];
}

async function main() {
  const target = await resolveStudioTarget();
  console.log(
    `[db-studio] Launching Prisma Studio against ${target.environment.toUpperCase()} (${target.envFile}) — ` +
      `close this terminal or Ctrl+C to stop.`
  );
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", buildStudioArgs(), {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: buildStudioSpawnEnv(target),
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Only run when executed directly (`node scripts/db-studio.mjs`), never
// when imported by tests. Deliberately NOT top-level await (some
// transform/bundling paths a test runner may put this file through don't
// support it) — a plain promise chain instead.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
