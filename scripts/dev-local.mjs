#!/usr/bin/env node
// Jedna komanda za ceo lokalni dev flow, bez Dockera i bez postojeće
// sistemske Postgres instalacije: pokreće embedded Postgres (inicijalizuje
// klaster ako je prvi put), primenjuje Prisma migracije, seed-uje dev
// naloge (ako već ne postoje), pa pokreće Next.js dev server sa
// DATABASE_URL ubrizganim direktno u child proces — nema potrebe za .env
// fajlom. Ctrl+C gasi i Next dev i embedded Postgres.
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { startLocalPostgres, runMigrations, seedIfEmpty, localDatabaseUrl } from "./lib/local-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const pg = await startLocalPostgres();
  runMigrations();
  await seedIfEmpty();

  console.log("");
  console.log("[dev-local] Pokrećem Next.js dev server ...");
  console.log("[dev-local] Dev nalozi: owner@dev.local / DevOwner123! (i ostali iz login ekrana)");
  console.log("");

  const next = spawn("npm", ["run", "dev", "--workspace=apps/web"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: localDatabaseUrl() },
  });

  let shuttingDown = false;
  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[dev-local] Zaustavljam Next.js i embedded Postgres ...");
    if (!next.killed) next.kill();
    await pg.stop();
    process.exit(code ?? 0);
  };

  next.on("exit", (code) => shutdown(code ?? 0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

main().catch((err) => {
  console.error("[dev-local] Greška:", err);
  process.exit(1);
});
