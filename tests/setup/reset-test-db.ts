/**
 * Jedina dozvoljena putanja za destruktivno pražnjenje tabela u integration
 * testovima. Svi tests/integration/*.test.ts fajlovi MORAJU zvati ove
 * funkcije umesto direktnog `TRUNCATE ... CASCADE` — centralizacija znači
 * da se bezbednosna provera radi na JEDNOM mestu, ne mora se ponavljati
 * (ispravno) u svakom od 50+ test fajlova.
 *
 * require-test-database.ts (vitest setupFiles) već proverava — JEDNOM po
 * test fajlu, pre nego što ijedan test krene — da DATABASE_URL/TEST_DATABASE_URL
 * cilja eksplicitno obeleženu test bazu. Provera ovde je NAMERNO jeftina
 * (sinhrona, bez mrežnog poziva) — dodatni sloj odbrane neposredno uz svaki
 * destruktivni poziv, za slučaj da nešto posle setupFiles promeni
 * process.env.DATABASE_URL usred izvršavanja.
 *
 * FAIL-CLOSED RESET (docs/printing-validation-2026-09-09.md): 2026-09-09
 * validacija je uhvatila da Postgres na ovoj (lokalnoj embedded, Windows)
 * mašini povremeno zaglavi na `IO / DataFileImmediateSync` unutar
 * TRUNCATE-a duže od Vitest-ovog hookTimeout-a (30000ms) — I, kritičnije,
 * da Vitest u tom slučaju SAMO odustaje od čekanja na hook, ali NE otkazuje
 * stvarni SQL koji i dalje radi u pozadini na istoj konekciji, pa sledeći
 * test/fajl može da krene dok je prethodni destruktivni TRUNCATE i dalje
 * aktivan (dokazano: drugi reset je čekao na row lock koji je držao prvi,
 * još aktivan i posle 32s). Ispod je namerno POSEBNA, IZOLOVANA konekcija
 * za svaki destruktivni upit (nikad deljeni Prisma pool) — jedino tako se
 * može pouzdano saznati TAČAN backend pid koji izvršava baš taj TRUNCATE, a
 * time i bezbedno otkazati/prekinuti BAŠ NJEGA (nikad proizvoljnu sesiju)
 * ako pređe sopstveni (strožiji od Vitest-ovog) rok. Ako se čak ni posle
 * prekida ne može potvrditi da je stao, ili čak i kad se potvrdi — reset i
 * dalje PADA (nema tihog "u redu je, probaj dalje").
 *
 * STVARNA garancija da NIJEDAN sledeći fixture ne može da krene je trajni
 * "poison" marker fajl na disku, upisan PRE bilo kakvog pokušaja gašenja —
 * PROVERENO u praksi (2026-09-09 combined run, isti pravi
 * `DataFileImmediateSync` zastoj se ponovio): Vitest (`pool: "forks"") za
 * vreme test run-a PRESREĆE `process.exit()` pozvan iz test/hook koda i
 * baca grešku umesto da stvarno ugasi worker, pa je nastavio da pokreće
 * SLEDEĆE fajlove — svaki od njih je ipak odmah odbio bilo kakav destruktivan
 * upit preko poison markera (dokazano: 0 preklapajućih TRUNCATE-ova, vidi
 * `maxConcurrentResets` u apps/print-agent artifacts), pa je bezbednost
 * održana i pored toga. Ispod se i dalje NAJPRE pokušava obično
 * `process.exit()` (čist put ako Vitest ne presretne), a ako to baci
 * (upravo taj presretnut slučaj), eskalira se na `process.kill(pid,
 * "SIGKILL")` — pravi OS signal koji NIJE presretljiv ni na jedan način —
 * da zaustavljanje bude što čistije/brže, ne kao jedina linija odbrane.
 */
import { Client } from "pg";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { looksLikeTestDatabaseName, parseDbIdentity } from "./db-identity";

function assertCurrentEnvIsTestDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !looksLikeTestDatabaseName(parseDbIdentity(url).database)) {
    throw new Error(
      "[db-safety] Odbijam da izvršim TRUNCATE — process.env.DATABASE_URL više ne cilja bazu čije ime " +
        'sadrži "test". Ovo bi trebalo da je nemoguće ako require-test-database.ts nije zaobiđen.'
    );
  }
  return url;
}

interface PrismaLikeExecutor {
  $executeRawUnsafe(query: string): Promise<unknown>;
}

interface PgLikeExecutor {
  query<T = unknown>(query: string, values?: unknown[]): Promise<{ rows: T[] }>;
  /** Opcionalno (pravi `pg.Client` ga ima, minimalni test dvojnici ne moraju)
   * — koristi se SAMO da se proguta OČEKIVAN 'error' event kad MI namerno
   * prekinemo ovu konekciju (vidi runGuardedDestructiveStatement ispod). */
  on?(event: "error", listener: (err: unknown) => void): unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Podesivi rokovi (svi namerno ISPOD Vitest-ovog hookTimeout od 30000ms u
// vitest.integration.config.ts, tako da NAŠ mehanizam uvek "pobedi" — proces
// se ugasi PRE nego što Vitest-ov sopstveni (problematičan, ne-otkazujući)
// hook timeout stigne da opali. Zbir najgoreg slučaja (13000+4000+4000 =
// 21000ms) ostavlja ~9s rezerve. Vrednosti su namerno velikodušne u odnosu
// na normalno trajanje (izmereno < 1s po resetu u praksi) — ne mogu lažno
// da okinu na normalnom radu, samo na stvarnoj anomaliji. ──
const DEFAULT_RESET_DEADLINE_MS = 13_000;
const DEFAULT_CANCEL_CONFIRM_MS = 4_000;
const DEFAULT_TERMINATE_CONFIRM_MS = 4_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_POISON_FILE = path.join(REPO_ROOT, ".local-postgres-data-test", "RESET_POISONED.json");

function realFatalExit(message: string): void {
  const banner = "=".repeat(70);
  console.error(`\n${banner}\n🛑 TEST DB RESET FAIL-CLOSED — aborting immediately\n${banner}\n${message}\n${banner}\n`);
  process.exitCode = 1;
  try {
    process.exit(1);
  } catch {
    // Vitest (pool: "forks") intercepts process.exit() DURING a test run and
    // throws instead of actually exiting, so it can report a clean "hook
    // failed" error instead of the whole runner silently dying — proven
    // empirically (docs/printing-validation-2026-09-09.md combined-run
    // evidence): with only a plain process.exit(), Vitest kept dispatching
    // further files after this one failed, each independently refusing via
    // the poison marker (which IS what actually guarantees no further
    // TRUNCATE ever runs — see refuseIfPoisoned) rather than the process
    // stopping. That fallback is safe but noisy (a multi-file failure
    // cascade instead of one clean stop). SIGKILL is a real OS signal, not
    // interceptable/convertible by any JS try/catch or runtime patch, so it
    // guarantees an immediate, unconditional halt of THIS worker the moment
    // process.exit() is caught out from under us.
  }
  process.kill(process.pid, "SIGKILL");
}

export interface ResetGuardDeps {
  /** Rok za sam destruktivni upit pre nego što se interveniše. */
  resetDeadlineMs?: number;
  /** Koliko dugo čekamo potvrdu posle pg_cancel_backend pre eskalacije. */
  cancelConfirmMs?: number;
  /** Koliko dugo čekamo potvrdu posle pg_terminate_backend. */
  terminateConfirmMs?: number;
  pollIntervalMs?: number;
  poisonFilePath?: string;
  /**
   * Poziva se KADA se reset ne može bezbedno ograničiti (rok premašen, ili
   * već postoji poison marker od ranije). PODRAZUMEVANO: pokušava
   * `process.exit(1)`, pa ako je presretnut (Vitest to radi za vreme test
   * run-a, vidi realFatalExit) eskalira na `process.kill(pid, "SIGKILL")` —
   * najbrži/najčistiji zaustavak koji je moguć. STVARNA garancija da nijedan
   * sledeći fixture ne pokrene NOVU destruktivnu SQL i dalje je poison
   * marker fajl (proveren i pisan PRE ovog poziva), ne ovaj poziv sam po
   * sebi. Injektabilno ISKLJUČIVO za
   * tests/integration/reset-fail-closed.test.ts, koji ne sme da dozvoli da
   * pravi process.exit/SIGKILL ubije sam test runner dok dokazuje mehanizam.
   */
  onFatal?: (message: string) => void;
}

interface ResolvedResetGuardDeps {
  resetDeadlineMs: number;
  cancelConfirmMs: number;
  terminateConfirmMs: number;
  pollIntervalMs: number;
  poisonFilePath: string;
  onFatal: (message: string) => void;
}

function resolveDeps(overrides?: ResetGuardDeps): ResolvedResetGuardDeps {
  return {
    resetDeadlineMs: overrides?.resetDeadlineMs ?? DEFAULT_RESET_DEADLINE_MS,
    cancelConfirmMs: overrides?.cancelConfirmMs ?? DEFAULT_CANCEL_CONFIRM_MS,
    terminateConfirmMs: overrides?.terminateConfirmMs ?? DEFAULT_TERMINATE_CONFIRM_MS,
    pollIntervalMs: overrides?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    poisonFilePath: overrides?.poisonFilePath ?? DEFAULT_POISON_FILE,
    onFatal: overrides?.onFatal ?? realFatalExit,
  };
}

function isPoisoned(deps: ResolvedResetGuardDeps): boolean {
  return existsSync(deps.poisonFilePath);
}

/** Prijavljuje i ODMAH prekida (poziva onFatal) ako je run već "otrovan" od
 * ranijeg neuspelog reseta — proverava se PRE otvaranja bilo koje konekcije,
 * da ni pokušaj ne startuje. */
function refuseIfPoisoned(deps: ResolvedResetGuardDeps): boolean {
  if (!isPoisoned(deps)) return false;
  let detail = "";
  try {
    detail = readFileSync(deps.poisonFilePath, "utf8");
  } catch {
    // fajl je nestao između provere i čitanja — svejedno ostajemo otrovani po pravilu "fail closed".
  }
  deps.onFatal(
    `[db-safety] Prethodni destruktivni TEST DB reset je premašio bezbedan rok i run je označen kao ` +
      `"otrovan" (${deps.poisonFilePath}). Odbijam BILO KOJI dalji destruktivni reset dok čovek ne proveri ` +
      `test bazu i ukloni ovaj fajl. Bez automatskog ponovnog pokušaja.\n${detail}`
  );
  return true;
}

function writePoisonMarker(deps: ResolvedResetGuardDeps, details: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(deps.poisonFilePath), { recursive: true });
    writeFileSync(deps.poisonFilePath, JSON.stringify({ ...details, poisonedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`[db-safety] Nisam uspeo da upišem poison marker na ${deps.poisonFilePath}: ${(err as Error).message}`);
  }
}

/** Proverava da li je backend `pid`, TAČNO obeležen sa `resetTag` (SET
 * application_name), i dalje POSTOJI (konekcija otvorena) u BAŠ ovoj bazi —
 * nikad se ne pretpostavlja da je pid isti ako se application_name/baza ne
 * poklapaju (zaštita od teorijskog ponovnog iskorišćenja pid-a). Koristi se
 * (a) za proveru vlasništva PRE bilo koje akcije i (b) za potvrdu posle
 * pg_terminate_backend (koji zatvara konekciju u celini). */
async function backendOwnedByThisReset(admin: Client, backendPid: number, resetTag: string): Promise<boolean> {
  const { rows } = await admin.query<{ owned: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
       WHERE pid = $1 AND application_name = $2 AND datname = current_database()
     ) AS owned`,
    [backendPid, resetTag]
  );
  return Boolean(rows[0]?.owned);
}

/** Da li BAŠ ovaj (dokazano vlasnički) backend i dalje AKTIVNO izvršava
 * upit — `pg_cancel_backend` NE zatvara konekciju, samo prekida TEKUĆI
 * upit (backend ostaje živ, prelazi u 'idle') — zato potvrda posle cancel-a
 * MORA proveravati `state`, nikad "da li backend uopšte postoji" (ta
 * provera bi uvek ostala tačna posle uspešnog cancel-a i lažno naterala
 * eskalaciju na terminate na SVAKOM slučaju). */
async function backendStillActive(admin: Client, backendPid: number, resetTag: string): Promise<boolean> {
  const { rows } = await admin.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
       WHERE pid = $1 AND application_name = $2 AND datname = current_database() AND state = 'active'
     ) AS active`,
    [backendPid, resetTag]
  );
  return Boolean(rows[0]?.active);
}

async function pollUntil(check: () => Promise<boolean>, windowMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Otkazuje/prekida ISKLJUČIVO backend dokazano vezan za ovaj reset (pid +
 * application_name tag + current_database() poklapanje) preko POSEBNE admin
 * konekcije (originalna konekcija je i dalje zauzeta zaglavljenim upitom).
 * Prvo kooperativan pg_cancel_backend (potvrda: upit više NIJE aktivan —
 * sama konekcija sme da ostane otvorena/idle), pa tek ako se to ne potvrdi
 * u roku, pg_terminate_backend (potvrda: konekcija je u celini zatvorena).
 * Nikad ne dira sesiju čije vlasništvo nije dokazano.
 */
async function stopBackendSafely(testUrl: string, backendPid: number, resetTag: string, deps: ResolvedResetGuardDeps): Promise<boolean> {
  let admin: Client;
  try {
    admin = new Client({ connectionString: testUrl });
    await admin.connect();
  } catch (err) {
    console.error(`[db-safety] Ne mogu da otvorim admin konekciju da interventišem na backend ${backendPid}: ${(err as Error).message}`);
    return false;
  }
  try {
    if (!(await backendOwnedByThisReset(admin, backendPid, resetTag))) {
      console.error(`[db-safety] Backend ${backendPid} se ne poklapa sa reset tag-om ${resetTag} — odbijam da diram neproverenu sesiju.`);
      return false;
    }

    await admin.query("SELECT pg_cancel_backend($1)", [backendPid]);
    if (await pollUntil(() => backendStillActive(admin, backendPid, resetTag).then((active) => !active), deps.cancelConfirmMs, deps.pollIntervalMs)) {
      return true;
    }

    if (!(await backendOwnedByThisReset(admin, backendPid, resetTag))) {
      return true; // nestao između provera — tretiramo kao zaustavljen
    }

    console.error(`[db-safety] pg_cancel_backend nije potvrđen za ${backendPid} u ${deps.cancelConfirmMs}ms — eskaliram na pg_terminate_backend.`);
    await admin.query("SELECT pg_terminate_backend($1)", [backendPid]);
    return await pollUntil(() => backendOwnedByThisReset(admin, backendPid, resetTag).then((owned) => !owned), deps.terminateConfirmMs, deps.pollIntervalMs);
  } catch (err) {
    console.error(`[db-safety] Greška pri pokušaju zaustavljanja backend-a ${backendPid}: ${(err as Error).message}`);
    return false;
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Izvršava PROIZVOLJAN SQL (u praksi uvek `TRUNCATE ... CASCADE`, ali
 * parametrizovano i preko `pg_sleep(...)` u
 * tests/integration/reset-fail-closed.test.ts da bi se fail-closed
 * mehanizam dokazao DETERMINISTIČKI, bez čekanja na sledeći slučajan I/O
 * zastoj) na `conn` — MORA biti POSEBNA, ničim drugim deljena konekcija
 * (nikad Prisma pool), inače se backend pid ne može pouzdano vezati za baš
 * ovaj upit. Izvezeno (ne samo interno) upravo zbog tog testa.
 */
export async function runGuardedDestructiveStatement(conn: PgLikeExecutor, testUrl: string, sql: string, overrideDeps?: ResetGuardDeps): Promise<void> {
  const deps = resolveDeps(overrideDeps);
  if (refuseIfPoisoned(deps)) return;

  // Postgres ne dozvoljava bind-parametar u SET komandi ($1 tu nije
  // podržan) — resetTag je UVEK naš sopstveni randomUUID() (fiksan
  // hex/crtica skup znakova, nikad spoljni unos), pa je direktno
  // interpolovanje ovde bezbedno.
  const resetTag = `rcs_test_reset_${randomUUID()}`;
  await conn.query(`SET application_name = '${resetTag}'`);
  const pidResult = await conn.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const backendPid = pidResult.rows[0]?.pid;
  if (typeof backendPid !== "number") {
    deps.onFatal("[db-safety] Nisam mogao da odredim backend pid za destruktivan TEST DB reset — odbijam da nastavim bez pozitivne identifikacije.");
    return;
  }

  let settled = false;
  const statementPromise = conn.query(sql).then(() => {
    settled = true;
  });
  statementPromise.catch(() => {}); // gutamo kasnije odbijanje pošto smo već krenuli dalje (npr. posle terminate-a)

  const outcome = await Promise.race([statementPromise.then(() => "done" as const), sleep(deps.resetDeadlineMs).then(() => "timeout" as const)]);

  if (outcome === "done" || settled) return;

  // Od ovog trenutka MI namerno prekidamo `conn` (cancel/terminate ispod) —
  // server-side prekid skoro sigurno izaziva asinhron 'error' event na
  // klijentu (npr. "terminating connection due to administrator command",
  // ECONNRESET) — OČEKIVANA posledica naše intervencije, ne stvaran
  // problem. Bez ovog rukovaoca Node bi to prijavio kao uncaught exception
  // i zagušio baš dijagnostiku koja je ovde najpotrebnija.
  conn.on?.("error", () => {});

  console.error(
    `\n${"=".repeat(70)}\n🛑 TEST DB RESET premašio ${deps.resetDeadlineMs}ms na backend-u ${backendPid} — intervenišem\n${"=".repeat(70)}\n`
  );
  const stopped = await stopBackendSafely(testUrl, backendPid, resetTag, deps);
  writePoisonMarker(deps, { backendPid, resetTag, sql, stopped, resetDeadlineMs: deps.resetDeadlineMs });
  deps.onFatal(
    `[db-safety] Destruktivan TEST DB reset ("${sql}") je premašio ${deps.resetDeadlineMs}ms na backend-u ${backendPid}. ` +
      (stopped
        ? "Backend je potvrđeno zaustavljen. "
        : "Zaustavljanje backend-a NIJE moglo da se potvrdi — bazu tretiramo kao nepouzdanu. ") +
      "Bez ponovnog pokušaja. Prekidam odmah da nijedan sledeći fixture/reset ne može da krene."
  );
}

/** Za integration testove koji koriste `prisma` iz @rcs/db.
 *
 * `_prisma` je namerno NEISKORIŠĆEN za sam TRUNCATE — zadržan samo radi
 * kompatibilnosti poziva u 48 postojećih integration test fajlova.
 * Destruktivan upit sada UVEK ide preko sopstvene, pojedinačno
 * identifikovane konekcije (nikad deljeni pool-ovani Prisma klijent) — to
 * je neophodno da bi se na timeout-u bezbedno otkazao/prekinuo TAČNO taj
 * backend, nikad proizvoljna pool-ovana sesija. Vidi napomenu na vrhu
 * fajla. */
export async function resetPrismaTestTables(_prisma: PrismaLikeExecutor, tables: string, overrideDeps?: ResetGuardDeps): Promise<void> {
  const testUrl = assertCurrentEnvIsTestDatabase();
  const deps = resolveDeps(overrideDeps);
  if (refuseIfPoisoned(deps)) return;

  const client = new Client({ connectionString: testUrl });
  await client.connect();
  try {
    await runGuardedDestructiveStatement(client, testUrl, `TRUNCATE ${tables} CASCADE`, overrideDeps);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Za integration testove koji otvaraju sopstveni raw `pg.Client` (već
 * POSEBNA, pojedinačna konekcija po fajlu — koristi se direktno, ne
 * otvaramo dodatnu). Vlasništvo/životni ciklus `client`-a ostaje kod
 * pozivaoca (otvoren u beforeAll, zatvoren u afterAll) — ovde se nikad ne
 * zatvara. */
export async function resetPgTestTables(client: PgLikeExecutor, tables: string, overrideDeps?: ResetGuardDeps): Promise<void> {
  const testUrl = assertCurrentEnvIsTestDatabase();
  const deps = resolveDeps(overrideDeps);
  if (refuseIfPoisoned(deps)) return;

  await runGuardedDestructiveStatement(client, testUrl, `TRUNCATE ${tables} CASCADE`, overrideDeps);
}
