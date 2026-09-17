// PREPROD-targeted `prisma migrate deploy` runner.
//
// WHY THIS EXISTS: the existing `db:migrate:deploy` npm script wraps
// `prisma migrate deploy` with `dotenv -e .env --`, which resolves
// root `.env` — the Production connection string. There is NO existing
// `db:preprod:migrate` script (see package.json). This file fills that
// gap and uses the same `resolveDatabaseTarget({ argv })` guarded entry
// point that `db-studio.mjs` and `db-premigration-check.mjs` use, so the
// target is resolved against `.env.local` AND cross-checked against
// the live `_rcs_database_environment` marker table before anything is
// run.
//
// Run:
//   node scripts/db-migrate-preprod.mjs
// It refuses to run against anything other than PREPROD — confirmed
// against the marker table AND the endpoint-id list.
//
// To deploy against PREPROD:
//   1. Ensure .env.local points at the PREPROD Neon branch.
//   2. Ensure _rcs_database_environment marker table reads DEVELOPMENT.
//   3. Run this script. It will print the target identity (endpoint id,
//      environment label, marker read) BEFORE invoking prisma migrate
//      deploy, so a human reviewer can sanity-check.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDatabaseTarget } from "./lib/resolve-db-target.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function main() {
  // resolveDatabaseTarget ALREADY validates against the live
  // _rcs_database_environment marker table and the known-endpoint
  // lists (KNOWN_DEVELOPMENT_ENDPOINT_IDS for preprod). If we got
  // here without an exception, the target is PREPROD. The only
  // remaining sanity check is that the CLI vocabulary is "preprod".
  const target = await resolveDatabaseTarget({ argv: ["--env=preprod"] });
  if (target.environment !== "preprod") {
    console.error(`Refusing to run: CLI environment is ${target.environment}, expected "preprod".`);
    process.exit(2);
  }
  console.log(`[db-migrate-preprod] Target: ${target.envFile}`);
  console.log(`[db-migrate-preprod] Endpoint: ${target.endpointId}`);
  console.log(`[db-migrate-preprod] Marker already cross-checked by resolveDatabaseTarget (DEVELOPMENT = PREPROD).`);
  console.log(`[db-migrate-preprod] Running: prisma migrate deploy --schema packages/db/prisma/schema.prisma`);
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "deploy", "--schema", "packages/db/prisma/schema.prisma"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: target.databaseUrl, DIRECT_URL: target.directUrl },
    }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
