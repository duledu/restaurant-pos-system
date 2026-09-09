// Deliberately ignores external TEST_DATABASE_URL; only the owned local test DB is used.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { startLocalTestPostgres, runTestMigrations, markAsTestDatabase, testDatabaseUrl } from '../../scripts/lib/local-test-db.mjs';

let pg;
let code = 1;
const mode = process.argv[2] ?? 'combined';
if (!['combined', 'isolated', 'regression'].includes(mode)) throw new Error('Use combined, isolated or regression');
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactDir = fileURLToPath(new URL('./artifacts/', import.meta.url));
mkdirSync(artifactDir, { recursive: true });
const observations = { mode, startedAt: new Date().toISOString(), samples: [], resetQueries: {}, maxConnections: 0, maxConcurrentResets: 0 };
let monitor;
let timer;
let sampling = false;
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const rows = (await monitor.query(`SELECT pid, state, wait_event_type, wait_event,
      extract(epoch from (clock_timestamp()-query_start))*1000 AS elapsed_ms,
      extract(epoch from (clock_timestamp()-xact_start))*1000 AS transaction_ms,
      pg_blocking_pids(pid) AS blockers, left(query, 200) AS query
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
    observations.maxConnections = Math.max(observations.maxConnections, rows.length);
    const resets = rows.filter(r => r.state === 'active' && r.query.startsWith('TRUNCATE'));
    observations.maxConcurrentResets = Math.max(observations.maxConcurrentResets, resets.length);
    for (const r of resets) {
      const key = `${r.pid}:${Math.round(Date.now()-Number(r.elapsed_ms))/1000 | 0}`;
      observations.resetQueries[key] = r;
    }
    if (resets.some(r => Number(r.elapsed_ms) > 1000) || rows.some(r => r.blockers.length || r.state === 'idle in transaction'))
      observations.samples.push({ at: new Date().toISOString(), rows });
  } catch (e) { observations.monitorError = String(e); }
  finally { sampling = false; }
}
try {
  pg = await startLocalTestPostgres();
  runTestMigrations();
  await markAsTestDatabase(testDatabaseUrl());
  monitor = new Client({ connectionString: testDatabaseUrl(), application_name: 'tablecore-test-diagnostics' });
  await monitor.connect();
  const health = async () => ({
    database: (await monitor.query('SELECT current_database() AS name, pg_database_size(current_database()) AS bytes')).rows,
    settings: (await monitor.query("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','checkpoint_timeout','max_wal_size','max_connections')")).rows,
    backgroundWriter: (await monitor.query('SELECT * FROM pg_stat_bgwriter')).rows,
    tables: (await monitor.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows,
  });
  observations.before = await health();
  await sample();
  timer = setInterval(sample, 200);
  const filters = mode === 'isolated' ? ['tests/integration/print-hardening.test.ts']
    : ['tests/integration/print-', 'tests/integration/settings', 'tests/integration/multi-round-ordering',
      ...(mode === 'regression' ? ['--exclude', 'tests/integration/print-hardening.test.ts'] : [])];
  const started = performance.now();
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.integration.config.ts', ...filters], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl() },
  });
  let output = '';
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]])
    stream.on('data', data => { output += data; target.write(data); });
  code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve(status ?? 1)); });
  observations.durationMs = Math.round(performance.now() - started);
  observations.after = await health();
  writeFileSync(`${artifactDir}/${mode}-${Date.now()}.log`, output);
} catch (error) {
  console.error(error);
} finally {
  clearInterval(timer);
  if (monitor) await monitor.end();
  observations.exitCode = code;
  writeFileSync(`${artifactDir}/${mode}-${Date.now()}.json`, JSON.stringify(observations, null, 2));
  console.log(`[validation] mode=${mode} exit=${code} durationMs=${observations.durationMs} maxConnections=${observations.maxConnections} maxConcurrentResets=${observations.maxConcurrentResets}`);
  if (pg) await pg.stop();
}
process.exit(code);
