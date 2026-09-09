// Deo istrage IO / DataFileImmediateSync zastoja (docs/printing-validation-2026-09-09.md,
// docs/printing-storage-investigation-2026-09-09.md) — meri STVARNU latenciju
// TRUNCATE-a (isti tačan SQL kao tests/setup/reset-test-db.ts) na SOPSTVENOJ
// izolovanoj lokalnoj TEST bazi, sa finijim (50ms) uzorkovanjem pg_stat_activity
// nego apps/print-agent/Test-TableCore.mjs (200ms), da bi se svaki spor
// ciklus tačno korelisao sa wait_event-om.
//
// Namerno NE uvozi tests/setup/reset-test-db.ts direktno (Node-ova native TS
// podrška ne rešava .ts->.ts relativne uvoze bez ekstenzije pouzdano) — ovde
// je REIMPLEMENTIRANA ISTA bezbedna otkaži/prekini logika (dedikovana
// konekcija, pg_backend_pid identifikacija, cancel pa terminate, potvrda),
// isključivo radi ovog dijagnostičkog alata. Ne menja i ne zamenjuje pravi
// harness u reset-test-db.ts.
//
// Bezbednost: ignoriše eksterni TEST_DATABASE_URL (kao i ostali alati u ovom
// direktorijumu), koristi ISKLJUČIVO sopstvenu embedded test bazu
// (127.0.0.1:55433/rcs_test), NIKAD ne menja fsync/full_page_writes/
// synchronous_commit, staje ODMAH (bez daljih ciklusa) ako se ijedan reset
// ne završi u roku — ne "hammera" stotine ponovljenih pokušaja.
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTestMigrations, markAsTestDatabase } from '../../scripts/lib/local-test-db.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Deploy-uje migracije na TAČNO `url` (nikad podrazumevani deljeni test URL)
 * — isti obrazac kao Verify-Migrations.mjs, neophodan za alt-volume slučaj
 * jer runTestMigrations() iz local-test-db.mjs uvek cilja deljeni URL. */
function deployMigrationsTo(url) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'],
    { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } }
  );
  if (result.status !== 0) throw new Error(`Migration deploy failed (exit ${result.status}) for ${url}`);
}

// Argumenti: [sampleCount] [altDataDir] [altPort]
// Bez altDataDir -> koristi POSTOJEĆU deljenu TEST bazu (127.0.0.1:55433,
// .local-postgres-data-test, ISTA kao stvarni integration testovi). Sa
// altDataDir (npr. "H:\\rcs-storage-profile") -> podiže POTPUNO ODVOJEN,
// jednokratan disposable klaster TAMO, sa ISTIM podešavanjima (fsync=on,
// full_page_writes=on, synchronous_commit=on, iste migracije, isti marker),
// SAMO radi A/B poređenja diska — nikad ne dira deljenu TEST bazu niti
// Development/Production.
const SAMPLE_COUNT = Number(process.argv[2] ?? 40); // "razuman kontrolisan uzorak", ne stotine
const ALT_DATA_DIR = process.argv[3] || null;
const ALT_PORT = Number(process.argv[4] ?? 55434);
const RESET_DEADLINE_MS = 13_000; // ISTI rok kao tests/setup/reset-test-db.ts (produkcioni default)
const NOTABLE_MS = 300; // ciklus vredan hvatanja wait-event traga (normalno je < 50ms)
const MONITOR_INTERVAL_MS = 50;

const artifactDir = fileURLToPath(new URL('./artifacts/', import.meta.url));
mkdirSync(artifactDir, { recursive: true });

async function startPostgresCluster() {
  if (!ALT_DATA_DIR) {
    const { startLocalTestPostgres, testDatabaseUrl } = await import('../../scripts/lib/local-test-db.mjs');
    const pg = await startLocalTestPostgres();
    return { pg, url: testDatabaseUrl(), dataDir: null, disposable: false };
  }

  // Disposable alternate-volume klaster — ISTI user/password/db naziv i
  // podešavanja kao deljena TEST baza, na DRUGOM portu i putanji da nikad
  // ne kolidira sa njom.
  const firstRun = !existsSync(ALT_DATA_DIR);
  mkdirSync(ALT_DATA_DIR, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: ALT_DATA_DIR,
    user: 'rcs_test',
    password: 'rcs_test_password',
    port: ALT_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (message) => console.error('[profile-storage:alt]', message),
  });
  if (firstRun || !existsSync(`${ALT_DATA_DIR}/PG_VERSION`)) {
    console.log(`[profile-storage] Inicijalizujem DISPOSABLE alternate-volume klaster u ${ALT_DATA_DIR} ...`);
    await pg.initialise();
  }
  await pg.start();
  await pg.createDatabase('rcs_test');
  const url = `postgresql://rcs_test:rcs_test_password@127.0.0.1:${ALT_PORT}/rcs_test?schema=public`;
  console.log(`[profile-storage] Alternate-volume klaster spreman na ${url}`);
  return { pg, url, dataDir: ALT_DATA_DIR, disposable: true };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function backendOwned(admin, pid, tag) {
  const { rows } = await admin.query(
    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND datname=current_database()) AS owned`,
    [pid, tag]
  );
  return Boolean(rows[0]?.owned);
}
async function backendActive(admin, pid, tag) {
  const { rows } = await admin.query(
    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND datname=current_database() AND state='active') AS active`,
    [pid, tag]
  );
  return Boolean(rows[0]?.active);
}
async function pollUntil(check, windowMs, intervalMs) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
/** Ista dvostepena (cancel pa terminate) bezbedna intervencija kao
 * tests/setup/reset-test-db.ts — reimplementirana ovde SAMO za dijagnostiku. */
async function stopBackendSafely(testUrl, pid, tag) {
  const admin = new Client({ connectionString: testUrl });
  await admin.connect();
  try {
    if (!(await backendOwned(admin, pid, tag))) return false;
    await admin.query('SELECT pg_cancel_backend($1)', [pid]);
    if (await pollUntil(() => backendActive(admin, pid, tag).then((a) => !a), 4000, 100)) return true;
    if (!(await backendOwned(admin, pid, tag))) return true;
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    return await pollUntil(() => backendOwned(admin, pid, tag).then((o) => !o), 4000, 100);
  } finally {
    await admin.end().catch(() => {});
  }
}

async function main() {
  console.log(`[profile-storage] Starting isolated TEST Postgres (${SAMPLE_COUNT} cycles${ALT_DATA_DIR ? `, ALT VOLUME ${ALT_DATA_DIR}` : ''}) ...`);
  const { pg, url: testUrl, dataDir, disposable } = await startPostgresCluster();
  if (ALT_DATA_DIR) {
    deployMigrationsTo(testUrl); // alt volumen -> deploy DIREKTNO na taj URL, ne na deljeni
  } else {
    runTestMigrations(); // podrazumevani slučaj -> postojeći helper (cilja isti deljeni testDatabaseUrl())
  }
  await markAsTestDatabase(testUrl);

  const monitor = new Client({ connectionString: testUrl, application_name: 'tablecore-storage-profile-monitor' });
  await monitor.connect();

  const env = {
    pgVersion: (await monitor.query('SHOW server_version')).rows[0].server_version,
    dataDirectory: (await monitor.query('SHOW data_directory')).rows[0].data_directory,
    walLevel: (await monitor.query('SHOW wal_level')).rows[0].wal_level,
    fsync: (await monitor.query('SHOW fsync')).rows[0].fsync,
    fullPageWrites: (await monitor.query('SHOW full_page_writes')).rows[0].full_page_writes,
    synchronousCommit: (await monitor.query('SHOW synchronous_commit')).rows[0].synchronous_commit,
    checkpointTimeout: (await monitor.query('SHOW checkpoint_timeout')).rows[0].checkpoint_timeout,
    tempTablespaces: (await monitor.query('SHOW temp_tablespaces')).rows[0].temp_tablespaces,
    databaseBytesBefore: (await monitor.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes,
  };
  console.log('[profile-storage] Environment:', env);

  // Uzorkuje SVAKIH 50ms — puni redovi se čuvaju SAMO za notable (>300ms) cikluse.
  const traces = {};
  let sampling = false;
  const monitorTimer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const { rows } = await monitor.query(`
        SELECT pid, state, wait_event_type, wait_event, backend_type, application_name,
               extract(epoch from (clock_timestamp()-query_start))*1000 AS elapsed_ms,
               pg_blocking_pids(pid) AS blockers, left(query,120) AS query
        FROM pg_stat_activity
        WHERE application_name LIKE 'tablecore-storage-profile-cycle-%' AND state='active'`);
      for (const r of rows) {
        if (Number(r.elapsed_ms) >= NOTABLE_MS) {
          (traces[r.application_name] ??= []).push({ at: new Date().toISOString(), ...r });
        }
      }
    } catch { /* monitor je ne-kritičan, best-effort */ }
    finally { sampling = false; }
  }, MONITOR_INTERVAL_MS);

  const results = [];
  let stoppedEarly = false;
  let stopReason = null;

  for (let i = 1; i <= SAMPLE_COUNT; i++) {
    // Skromna, realistična fixture pre svakog reseta (ista tabele koje se
    // trunkiraju) — mirroring tipičnog integration test beforeEach.
    const tag = `tablecore-storage-profile-cycle-${i}-${randomUUID()}`;
    const conn = new Client({ connectionString: testUrl });
    await conn.connect();
    conn.on('error', () => {}); // očekivano ako MI prekinemo konekciju ispod
    try {
      await conn.query(`SET application_name = '${tag}'`);
      const tenantId = randomUUID();
      await conn.query(
        `INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1,'Profile','profile-'||$1, now())`,
        [tenantId]
      );
      await conn.query(`INSERT INTO permissions (id, code) VALUES ($1, $2)`, [randomUUID(), `profile.cycle.${i}`]);
      await conn.query(`INSERT INTO login_throttles (key, "failedAttempts", "updatedAt") VALUES ($1, 1, now())`, [
        `profile-${i}-${randomUUID()}`,
      ]);

      const pidRow = await conn.query('SELECT pg_backend_pid() AS pid');
      const pid = pidRow.rows[0].pid;

      const start = performance.now();
      let done = false;
      const truncateP = conn
        .query('TRUNCATE tenants, permissions, login_throttles CASCADE')
        .then(() => { done = true; });
      truncateP.catch(() => {});

      const outcome = await Promise.race([
        truncateP.then(() => 'done'),
        sleep(RESET_DEADLINE_MS).then(() => 'timeout'),
      ]);
      const elapsedMs = performance.now() - start;

      if (outcome === 'timeout' && !done) {
        console.error(`[profile-storage] cycle ${i}: EXCEEDED ${RESET_DEADLINE_MS}ms on backend ${pid} — stopping safely, no further cycles`);
        const stopped = await stopBackendSafely(testUrl, pid, tag);
        results.push({ cycle: i, ms: Math.round(elapsedMs), timedOut: true, stopped, backendPid: pid });
        stoppedEarly = true;
        stopReason = `cycle ${i} exceeded ${RESET_DEADLINE_MS}ms (stopped=${stopped})`;
        await conn.end().catch(() => {});
        break;
      }

      results.push({ cycle: i, ms: Math.round(elapsedMs), timedOut: false });
    } finally {
      if (!stoppedEarly) await conn.end().catch(() => {});
    }
  }

  clearInterval(monitorTimer);
  await sleep(100); // pusti poslednji monitor tick da završi
  const dbBytesAfter = (await monitor.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes;
  const bgwriter = (await monitor.query('SELECT * FROM pg_stat_bgwriter')).rows[0];
  await monitor.end();
  await pg.stop();
  if (disposable && dataDir) {
    console.log(`[profile-storage] Uklanjam disposable alternate-volume klaster: ${dataDir}`);
    rmSync(dataDir, { recursive: true, force: true });
  }

  const timings = results.filter((r) => !r.timedOut).map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (timings.length ? timings[Math.min(timings.length - 1, Math.floor((p / 100) * timings.length))] : null);
  const summary = {
    volume: ALT_DATA_DIR ?? '(default: C:\\...\\.local-postgres-data-test)',
    samples: timings.length,
    stoppedEarly,
    stopReason,
    minMs: timings[0] ?? null,
    medianMs: pct(50),
    p95Ms: pct(95),
    maxMs: timings.at(-1) ?? null,
  };

  console.log('[profile-storage] Summary:', summary);
  console.log('[profile-storage] Notable (>=300ms) traces captured for:', Object.keys(traces).length, 'cycles');

  const artifactPath = `${artifactDir}/storage-profile-${ALT_DATA_DIR ? 'alt-' : 'default-'}${Date.now()}.json`;
  writeFileSync(
    artifactPath,
    JSON.stringify({ env, results, summary, traces, dbBytesBefore: env.databaseBytesBefore, dbBytesAfter, bgwriter }, null, 2)
  );
  console.log('[profile-storage] Artifact written:', artifactPath);
  process.exit(stoppedEarly ? 1 : 0);
}

main().catch((err) => {
  console.error('[profile-storage] Fatal error:', err);
  process.exit(1);
});
