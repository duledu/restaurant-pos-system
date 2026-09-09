// Disposable database on the owned TEST cluster only. Never accepts a database URL.
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startLocalTestPostgres, testDatabaseUrl, markAsTestDatabase } from '../../scripts/lib/local-test-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const folder = fileURLToPath(new URL(`./artifacts/migration-${Date.now()}/`, import.meta.url));
const database = `rcs_migration_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(testDatabaseUrl()); url.pathname = `/${database}`;
let cluster, admin, db, prisma;
let created = false;
function deploy() {
  const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', `${folder}/schema.prisma`], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href, DIRECT_URL: url.href },
  });
  assert.equal(result.status, 0, 'Migration deploy');
}
try {
  cluster = await startLocalTestPostgres();
  admin = new Client({ connectionString: testDatabaseUrl() }); await admin.connect();
  assert.match(database, /^rcs_migration_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  mkdirSync(`${folder}/migrations`, { recursive: true });
  cpSync(`${root}/packages/db/prisma/schema.prisma`, `${folder}/schema.prisma`);
  const migrations = readdirSync(`${root}/packages/db/prisma/migrations`).filter(x => /^\d/.test(x)).sort();
  const added = migrations.filter(x => x.startsWith('2026091000000'));
  assert.equal(added.length, 2);
  for (const name of migrations.filter(x => !added.includes(x))) cpSync(`${root}/packages/db/prisma/migrations/${name}`, `${folder}/migrations/${name}`, { recursive: true });
  cpSync(`${root}/packages/db/prisma/migrations/migration_lock.toml`, `${folder}/migrations/migration_lock.toml`);
  deploy();
  // Prisma requires a truly empty schema for its first deployment. Match the
  // established local runner: migrate this script-created database, then mark
  // it before inserting fixtures. No reset or integration safety gate is bypassed.
  await markAsTestDatabase(url.href);
  db = new Client({ connectionString: url.href }); await db.connect();
  assert.equal((await db.query("SELECT count(*) FROM information_schema.columns WHERE table_name='print_jobs' AND column_name='attemptId'")).rows[0].count, '0');
  prisma = new PrismaClient({ datasources: { db: { url: url.href } } });
  const tenant = await prisma.tenant.create({ data: { name: 'Migration test', slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: 'Migration test' } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: 'Test' } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: 'Test' } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: 'Test' } });
  const shift = await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: 'migration-test' } });
  const order = await prisma.order.create({ data: { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, shiftId: shift.id, openedBy: 'migration-test' } });
  await db.query(`INSERT INTO printer_configs (id,"restaurantId","locationId",station,name,"autoPrint","updatedAt") VALUES ('config',$1,$2,'KITCHEN','Test',false,now())`, [restaurant.id, location.id]);
  for (const status of ['PENDING', 'PRINTING', 'PRINTED', 'FAILED']) {
    await db.query(`INSERT INTO print_jobs (id,"restaurantId","locationId","orderId",type,station,"dispatchKey",status,"attemptCount",content,"requestedBy","updatedAt")
      VALUES ($1,$2,$3,$4,'KITCHEN','KITCHEN',$5,$6::"PrintJobStatus",2,'{"paperWidthMm":58}','migration-test',now())`,
    [status, restaurant.id, location.id, order.id, `submit:KITCHEN:${status}`, status]);
  }
  await prisma.$disconnect(); prisma = null;
  for (const name of added) cpSync(`${root}/packages/db/prisma/migrations/${name}`, `${folder}/migrations/${name}`, { recursive: true });
  deploy();
  const rows = (await db.query('SELECT id,status,"attemptCount","attemptId","submissionStartedAt","resultOutcome","isAutomatic",content FROM print_jobs ORDER BY id')).rows;
  for (const row of rows) {
    assert.equal(row.status, ({ PENDING: 'SUPPRESSED', PRINTING: 'SUBMISSION_UNKNOWN', PRINTED: 'PRINTED', FAILED: 'FAILED' })[row.id]);
    assert.equal(row.attemptCount, 2); assert.equal(row.attemptId, null); assert.equal(row.isAutomatic, true);
    assert.deepEqual(row.content, { paperWidthMm: 58 });
  }
  assert.equal(rows.find(x => x.id === 'PRINTING').resultOutcome, 'SUBMISSION_UNKNOWN');
  assert.ok(rows.find(x => x.id === 'PRINTING').submissionStartedAt);
  const indexes = (await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename IN ('print_jobs','printer_configs') ORDER BY indexname")).rows;
  for (const name of ['print_jobs_orderId_dispatchKey_key', 'printer_configs_locationId_station_key', 'print_jobs_status_idx', 'print_jobs_restaurantId_idx']) assert.ok(indexes.some(x => x.indexname === name), name);
  const constraints = (await db.query("SELECT conname FROM pg_constraint WHERE conrelid='print_jobs'::regclass")).rows;
  assert.ok(constraints.some(x => x.conname === 'print_jobs_orderId_fkey'));
  assert.ok(constraints.some(x => x.conname === 'print_jobs_reprintOfId_fkey'));
  writeFileSync(`${folder}/result.json`, JSON.stringify({ database, rows, indexes, constraints, passed: true }, null, 2));
  console.log('PASS: prior 20 migrations, both additive migrations, legacy conversion, frozen content, counters, indexes and constraints.');
} finally {
  if (prisma) await prisma.$disconnect();
  if (db) await db.end();
  if (admin) {
    // Only this script-created, randomly named TEST database can be dropped.
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
  if (cluster) await cluster.stop();
}
