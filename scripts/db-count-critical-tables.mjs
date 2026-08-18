#!/usr/bin/env node
// Read-only spot-check: broji redove u kritičnim (istorijski/finansijski
// osetljivim) tabelama trenutne DATABASE_URL baze. Namenjeno za
// pre/posle-poređenje oko rizičnih operacija (npr. pre/posle punog test
// suite-a — vidi docs/database-safety.md #9) — NIKAD ne piše u bazu.
//
// Pokreni: npm run db:counts   (koristi DATABASE_URL iz .env — DEV/PROD, ne test)
import { Client } from "pg";

const TABLES = [
  "tenants",
  "restaurants",
  "locations",
  "users",
  "employees",
  "devices",
  "menu_categories",
  "menu_items",
  "orders",
  "order_items",
  "payments",
  "receipts",
  "shifts",
  "order_item_voids",
  "audit_logs",
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nije postavljen.");
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const counts = {};
  try {
    for (const table of TABLES) {
      const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      counts[table] = res.rows[0].n;
    }
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
