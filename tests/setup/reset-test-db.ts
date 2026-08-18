/**
 * Jedina dozvoljena putanja za destruktivno pražnjenje tabela u integration
 * testovima. Svi tests/integration/*.test.ts fajlovi MORAJU zvati ove
 * funkcije umesto direktnog `TRUNCATE ... CASCADE` — centralizacija znači
 * da se bezbednosna provera radi na JEDNOM mestu, ne mora se ponavljati
 * (ispravno) u svakom od 13+ test fajlova.
 *
 * require-test-database.ts (vitest setupFiles) već proverava — JEDNOM po
 * test fajlu, pre nego što ijedan test krene — da DATABASE_URL/TEST_DATABASE_URL
 * cilja eksplicitno obeleženu test bazu. Provera ovde je NAMERNO jeftina
 * (sinhrona, bez mrežnog poziva) — dodatni sloj odbrane neposredno uz svaki
 * destruktivni poziv, za slučaj da nešto posle setupFiles promeni
 * process.env.DATABASE_URL usred izvršavanja.
 */
import { looksLikeTestDatabaseName, parseDbIdentity } from "./db-identity";

function assertCurrentEnvIsTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url || !looksLikeTestDatabaseName(parseDbIdentity(url).database)) {
    throw new Error(
      "[db-safety] Odbijam da izvršim TRUNCATE — process.env.DATABASE_URL više ne cilja bazu čije ime " +
        'sadrži "test". Ovo bi trebalo da je nemoguće ako require-test-database.ts nije zaobiđen.'
    );
  }
}

interface PrismaLikeExecutor {
  $executeRawUnsafe(query: string): Promise<unknown>;
}

interface PgLikeExecutor {
  query(query: string): Promise<unknown>;
}

/** Za integration testove koji koriste `prisma` iz @rcs/db. */
export async function resetPrismaTestTables(prisma: PrismaLikeExecutor, tables: string): Promise<void> {
  assertCurrentEnvIsTestDatabase();
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} CASCADE`);
}

/** Za integration testove koji otvaraju sopstveni raw `pg.Client`. */
export async function resetPgTestTables(client: PgLikeExecutor, tables: string): Promise<void> {
  assertCurrentEnvIsTestDatabase();
  await client.query(`TRUNCATE ${tables} CASCADE`);
}
