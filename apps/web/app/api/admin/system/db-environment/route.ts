import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import { requirePermission } from "@rcs/auth";
import { withApiAuth } from "../../../../../lib/api-helpers";

/**
 * Bezbednosni dijagnostički endpoint — potvrđuje na koju bazu je TRENUTNI
 * deployment (Production ili Preview) stvarno povezan, bez ikad vraćanja
 * connection string-a, korisnika ili lozinke. Namenjen isključivo pozitivnoj
 * proveri "Preview != Production baza" pre bilo kakvog mutable Preview
 * testiranja (vidi docs/database-safety.md) — nikad se ne poziva iz
 * normalnog POS toka.
 *
 * `environment` dolazi iz `_rcs_database_environment` marker tabele
 * (upisuje je isključivo scripts/mark-database-environment.mjs).
 * `endpointId` je samo prvi deo Neon hostname-a (npr. "ep-solitary-leaf-
 * b1q2002q") — javni deo adrese, ne sadrži kredencijale.
 */
export const GET = withApiAuth(async (ctx) => {
  requirePermission(ctx, "audit.view");

  let environment: string | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ environment: string }>>(
      `SELECT environment FROM "_rcs_database_environment" WHERE id = true`
    );
    environment = rows[0]?.environment ?? null;
  } catch {
    environment = null; // marker tabela ne postoji / nije dostupna
  }

  let endpointId: string | null = null;
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").host;
    endpointId = host.split(".")[0]?.replace(/-pooler$/, "") ?? null;
  } catch {
    endpointId = null;
  }

  return NextResponse.json({ environment, endpointId });
});
