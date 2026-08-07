/**
 * Testira DB-nivo garancije koje order-service.ts i shift-service.ts
 * koriste kao "krajnju liniju odbrane" protiv race condition-a — protiv
 * realnog Postgres-a, isti razlog kao ostali integracioni testovi (vidi
 * napomenu u tenant-isolation.test.ts o sandbox mrežnom ograničenju).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://rcs:rcs_dev_password@localhost:5432/rcs_dev?schema=public";

let client: Client;
let restaurantId: string;
let locationId: string;
let tableId: string;

beforeAll(async () => {
  client = new Client({ connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(
    `TRUNCATE tenants, restaurants, locations, floors, restaurant_tables, shifts, orders, order_items, order_events CASCADE`
  );
  const tenantId = randomUUID();
  restaurantId = randomUUID();
  locationId = randomUUID();
  const floorId = randomUUID();
  tableId = randomUUID();

  await client.query(`INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1,'T','t-'||$1, now())`, [
    tenantId,
  ]);
  await client.query(`INSERT INTO restaurants (id, "tenantId", name, "updatedAt") VALUES ($1,$2,'R', now())`, [
    restaurantId,
    tenantId,
  ]);
  await client.query(`INSERT INTO locations (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'L', now())`, [
    locationId,
    restaurantId,
  ]);
  await client.query(`INSERT INTO floors (id, "restaurantId", "locationId", name, "updatedAt") VALUES ($1,$2,$3,'F', now())`, [
    floorId,
    restaurantId,
    locationId,
  ]);
  await client.query(`INSERT INTO restaurant_tables (id, "floorId", label, "updatedAt") VALUES ($1,$2,'Sto 1', now())`, [
    tableId,
    floorId,
  ]);
});

describe("Shift — samo jedna otvorena smena po lokaciji", () => {
  it("druga otvorena smena na istoj lokaciji pada na partial unique index", async () => {
    await client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e1')`, [
      randomUUID(),
      restaurantId,
      locationId,
    ]);
    await expect(
      client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e2')`, [
        randomUUID(),
        restaurantId,
        locationId,
      ])
    ).rejects.toThrow();
  });

  it("nakon zatvaranja prve, nova otvorena smena na istoj lokaciji je dozvoljena", async () => {
    const firstId = randomUUID();
    await client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e1')`, [
      firstId,
      restaurantId,
      locationId,
    ]);
    await client.query(`UPDATE shifts SET status = 'CLOSED', "closedAt" = now(), "closedBy" = 'e1' WHERE id = $1`, [
      firstId,
    ]);
    await expect(
      client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e2')`, [
        randomUUID(),
        restaurantId,
        locationId,
      ])
    ).resolves.toBeTruthy();
  });

  it("otvorene smene na DVE RAZLIČITE lokacije ne konfliktuju", async () => {
    const otherLocationId = randomUUID();
    await client.query(`INSERT INTO locations (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'L2', now())`, [
      otherLocationId,
      restaurantId,
    ]);
    await client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e1')`, [
      randomUUID(),
      restaurantId,
      locationId,
    ]);
    await expect(
      client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e2')`, [
        randomUUID(),
        restaurantId,
        otherLocationId,
      ])
    ).resolves.toBeTruthy();
  });
});

describe("Order — idempotency key sprečava dupli submit", () => {
  async function openShiftAndOrder() {
    const shiftId = randomUUID();
    const orderId = randomUUID();
    await client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e1')`, [
      shiftId,
      restaurantId,
      locationId,
    ]);
    await client.query(
      `INSERT INTO orders (id, "restaurantId", "locationId", "tableId", "shiftId", "openedBy", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,'e1', now())`,
      [orderId, restaurantId, locationId, tableId, shiftId]
    );
    return { shiftId, orderId };
  }

  it("dva submit-a sa istim idempotencyKey za istu porudžbinu — drugi pokušaj je no-op (UPDATE ne pravi novi red)", async () => {
    const { orderId } = await openShiftAndOrder();
    const key = randomUUID();

    await client.query(`UPDATE orders SET status='SUBMITTED', "idempotencyKey"=$1, "submittedAt"=now() WHERE id=$2`, [
      key,
      orderId,
    ]);

    // Simulacija retry-ja: pokušaj INSERT nove porudžbine sa istim ključem
    // (ono što bi se desilo da servis pogrešno kreira novi red umesto da
    // prepozna postojeći) MORA pasti na unique constraint.
    await expect(
      client.query(
        `INSERT INTO orders (id, "restaurantId", "locationId", "tableId", "shiftId", "openedBy", "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4,(SELECT id FROM shifts WHERE "restaurantId"=$2 LIMIT 1),'e1',$5, now())`,
        [randomUUID(), restaurantId, locationId, tableId, key]
      )
    ).rejects.toThrow();

    const result = await client.query(`SELECT count(*) FROM orders WHERE "restaurantId"=$1`, [restaurantId]);
    expect(Number(result.rows[0].count)).toBe(1);
  });

  it("isti idempotencyKey se može ponovo koristiti za DRUGI restoran (scope je po restoranu)", async () => {
    const { orderId } = await openShiftAndOrder();
    const key = randomUUID();
    await client.query(`UPDATE orders SET "idempotencyKey"=$1 WHERE id=$2`, [key, orderId]);

    const tenantId2 = randomUUID();
    const restaurantId2 = randomUUID();
    const locationId2 = randomUUID();
    const floorId2 = randomUUID();
    const tableId2 = randomUUID();
    const shiftId2 = randomUUID();

    await client.query(`INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1,'T2','t2-'||$1, now())`, [
      tenantId2,
    ]);
    await client.query(`INSERT INTO restaurants (id, "tenantId", name, "updatedAt") VALUES ($1,$2,'R2', now())`, [
      restaurantId2,
      tenantId2,
    ]);
    await client.query(`INSERT INTO locations (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'L', now())`, [
      locationId2,
      restaurantId2,
    ]);
    await client.query(
      `INSERT INTO floors (id, "restaurantId", "locationId", name, "updatedAt") VALUES ($1,$2,$3,'F', now())`,
      [floorId2, restaurantId2, locationId2]
    );
    await client.query(`INSERT INTO restaurant_tables (id, "floorId", label, "updatedAt") VALUES ($1,$2,'Sto 1', now())`, [
      tableId2,
      floorId2,
    ]);
    await client.query(`INSERT INTO shifts (id, "restaurantId", "locationId", "openedBy") VALUES ($1,$2,$3,'e1')`, [
      shiftId2,
      restaurantId2,
      locationId2,
    ]);

    await expect(
      client.query(
        `INSERT INTO orders (id, "restaurantId", "locationId", "tableId", "shiftId", "openedBy", "idempotencyKey", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,'e1',$6, now())`,
        [randomUUID(), restaurantId2, locationId2, tableId2, shiftId2, key]
      )
    ).resolves.toBeTruthy();
  });
});
