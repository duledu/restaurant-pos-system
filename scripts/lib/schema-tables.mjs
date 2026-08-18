// Derives the list of actual database table names DIRECTLY from
// packages/db/prisma/schema.prisma (every `model X { ... @@map("y") }`
// block), instead of a hand-maintained array. This is deliberate: backup
// verification must automatically pick up new tables (e.g. the future
// Inventory module) without anyone remembering to edit a hardcoded list.
import { readFileSync } from "fs";
import { join } from "path";
import { repoRoot } from "./env-loader.mjs";

const SCHEMA_PATH = join(repoRoot, "packages", "db", "prisma", "schema.prisma");

/** @returns {Array<{model: string, table: string}>} every model→table mapping in the schema, in file order */
export function getAllTables() {
  const text = readFileSync(SCHEMA_PATH, "utf8");
  const lines = text.split("\n");
  const result = [];
  let currentModel = null;
  for (const line of lines) {
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      currentModel = modelMatch[1];
      continue;
    }
    if (line.trim() === "}") {
      currentModel = null;
      continue;
    }
    const mapMatch = line.match(/@@map\("(\w+)"\)/);
    if (mapMatch && currentModel) {
      result.push({ model: currentModel, table: mapMatch[1] });
    }
  }
  return result;
}

// Business-critical models called out explicitly by the backup/recovery
// requirements (menu, orders, payments, receipts, shifts, voids, audit,
// print jobs, and the tenancy/identity tables needed to make sense of any
// of it). Matched by MODEL name against whatever schema.prisma currently
// maps them to — so a future @@map rename doesn't silently break this list,
// and any model added later that isn't in this array is still covered by
// the full-schema comparison in scripts/db-backup-verify.mjs.
const CRITICAL_MODELS = [
  "Restaurant",
  "Location",
  "Employee",
  "MenuCategory",
  "MenuItem",
  "Order",
  "OrderItem",
  "OrderItemStation",
  "Payment",
  "Receipt",
  "Shift",
  "OrderItemVoid",
  "PrintJob",
  "AuditLog",
];

/** @returns {Array<{model: string, table: string}>} */
export function getCriticalTables() {
  const all = getAllTables();
  const byModel = new Map(all.map((t) => [t.model, t.table]));
  const missing = CRITICAL_MODELS.filter((m) => !byModel.has(m));
  if (missing.length > 0) {
    throw new Error(
      `schema-tables: expected model(s) not found in schema.prisma (renamed?): ${missing.join(", ")}`
    );
  }
  return CRITICAL_MODELS.map((m) => ({ model: m, table: byModel.get(m) }));
}

/**
 * Models whose table name suggests they belong to a future Inventory
 * module (InventoryItem, InventoryMovement, StockLevel, ...). Purely
 * informational — used so backup verification can call out "N inventory
 * table(s) detected and included" once that module exists, without this
 * file needing an edit.
 * @returns {Array<{model: string, table: string}>}
 */
export function getInventoryTables() {
  return getAllTables().filter((t) => /inventory|stock/i.test(t.model));
}
