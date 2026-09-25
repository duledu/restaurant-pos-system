#!/usr/bin/env node
/**
 * Sanctioned `prisma migrate deploy` wrapper — the ONLY way migrations
 * should be applied to a real (non-test) database.
 *
 * Objective 1 (Production release tooling hardening): replaces the old
 * `db:migrate:deploy` npm script, which was `dotenv -e .env -- npm run
 * migrate:deploy --workspace=packages/db` — that always resolved root
 * `.env`'s plain DATABASE_URL/DIRECT_URL, with no explicit target and no
 * safety gate. This wrapper resolves the target via resolveDatabaseTarget()
 * (the same mechanism db-studio.mjs, db-premigration-check.mjs, and
 * db-postmigration-check.mjs use — see scripts/lib/resolve-db-target.mjs)
 * and injects DATABASE_URL/DIRECT_URL into the spawned Prisma CLI's OWN
 * child-process environment only. It never mutates this script's own
 * process.env and never writes to any .env/.env.local file.
 *
 * Never applies dev-only or destructive commands — this only ever runs
 * `prisma migrate deploy` (the read-only-until-explicitly-run-migrate-deploy
 * Prisma command), never `migrate dev`, `db push`, or a reset.
 *
 * Run: npm run db:migrate:deploy -- --env=preprod
 *      npm run db:migrate:deploy -- --env=production --confirm-production
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./lib/env-loader.mjs";
import { resolveDatabaseTarget, buildChildEnv } from "./lib/resolve-db-target.mjs";

async function main() {
  const target = await resolveDatabaseTarget();
  const schemaPath = join(repoRoot, "packages", "db", "prisma", "schema.prisma");

  console.log(`[db-migrate-deploy] Applying migrations against ${target.environment.toUpperCase()} (${target.envFile})...`);

  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], {
    cwd: repoRoot,
    stdio: "inherit",
    env: buildChildEnv(target),
    shell: process.platform === "win32",
  });

  console.log(`\n[db-migrate-deploy] OK — migrations applied against ${target.environment.toUpperCase()}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
