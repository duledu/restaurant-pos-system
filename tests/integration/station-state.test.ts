import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://rcs:rcs_dev_password@localhost:5432/rcs_dev?schema=public";

let client: Client;
let orderItemId: string;
let orderId: string;

beforeAll(async () => {
  client = new Client({ connectionString });
  await client.connect();
});

afterAll(async () => client.end());

beforeEach(async () => {
  await client.query(
    `TRUNCATE tenants, restaurants, locations, floors, restaurant_tables,
     shifts, orders, order_items, order_item_stations CASCADE`
  );

  const tenantId = randomUUID();
  const restaurantId = randomUUID();
  const locationId = randomUUID();
  const floorId = randomUUID();
  const tableId = randomUUID();
  const shiftId = randomUUID();
  orderId = randomUUID();
  orderItemId = randomUUID();

  await client.query(`INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,'T',$2,now())`, [tenantId, tenantId]);
  await client.query(`INSERT INTO restaurants (id,"tenantId",name,"updatedAt") VALUES ($1,$2,'R',now())`, [restaurantId, tenantId]);
  await client.query(`INSERT INTO locations (id,"restaurantId",name,"updatedAt") VALUES ($1,$2,'L',now())`, [locationId, restaurantId]);
  await client.query(`INSERT INTO floors (id,"restaurantId","locationId",name,"updatedAt") VALUES ($1,$2,$3,'F',now())`, [floorId, restaurantId, locationId]);
  await client.query(`INSERT INTO restaurant_tables (id,"floorId",label,"updatedAt") VALUES ($1,$2,'1',now())`, [tableId, floorId]);
  await client.query(`INSERT INTO shifts (id,"restaurantId","locationId","openedBy") VALUES ($1,$2,$3,'waiter')`, [shiftId, restaurantId, locationId]);
  await client.query(
    `INSERT INTO orders (id,"restaurantId","locationId","tableId","shiftId","openedBy",status,"updatedAt")
     VALUES ($1,$2,$3,$4,$5,'waiter','SUBMITTED',now())`,
    [orderId, restaurantId, locationId, tableId, shiftId]
  );
  await client.query(
    `INSERT INTO order_items (id,"orderId",name,price,"taxRate","preparationStation",status,"updatedAt")
     VALUES ($1,$2,'Combo',100,20,'KITCHEN_AND_BAR','SUBMITTED',now())`,
    [orderItemId, orderId]
  );
});

describe("independent production station state", () => {
  it("keeps one commercial item with one state per station", async () => {
    await client.query(
      `INSERT INTO order_item_stations (id,"orderItemId",station,status,"updatedAt")
       VALUES ($1,$3,'KITCHEN','SUBMITTED',now()),($2,$3,'BAR','SUBMITTED',now())`,
      [randomUUID(), randomUUID(), orderItemId]
    );

    const commercialItems = await client.query(`SELECT id FROM order_items WHERE id=$1`, [orderItemId]);
    const states = await client.query(`SELECT station,status FROM order_item_stations WHERE "orderItemId"=$1 ORDER BY station::text`, [orderItemId]);
    expect(commercialItems.rows).toHaveLength(1);
    expect(states.rows).toEqual([
      { station: "BAR", status: "SUBMITTED" },
      { station: "KITCHEN", status: "SUBMITTED" },
    ]);
  });

  it("advancing kitchen does not advance bar", async () => {
    await client.query(
      `INSERT INTO order_item_stations (id,"orderItemId",station,status,"updatedAt")
       VALUES ($1,$3,'KITCHEN','SUBMITTED',now()),($2,$3,'BAR','SUBMITTED',now())`,
      [randomUUID(), randomUUID(), orderItemId]
    );
    await client.query(
      `UPDATE order_item_stations SET status='ACCEPTED',"updatedAt"=now()
       WHERE "orderItemId"=$1 AND station='KITCHEN'`,
      [orderItemId]
    );

    const states = await client.query(`SELECT station,status FROM order_item_stations WHERE "orderItemId"=$1 ORDER BY station::text`, [orderItemId]);
    expect(states.rows).toEqual([
      { station: "BAR", status: "SUBMITTED" },
      { station: "KITCHEN", status: "ACCEPTED" },
    ]);
  });

  it("prevents duplicate state rows for the same station", async () => {
    await client.query(
      `INSERT INTO order_item_stations (id,"orderItemId",station,status,"updatedAt") VALUES ($1,$2,'KITCHEN','SUBMITTED',now())`,
      [randomUUID(), orderItemId]
    );
    await expect(
      client.query(
        `INSERT INTO order_item_stations (id,"orderItemId",station,status,"updatedAt") VALUES ($1,$2,'KITCHEN','SUBMITTED',now())`,
        [randomUUID(), orderItemId]
      )
    ).rejects.toThrow();
  });

  it("cascades station state deletion with its commercial item", async () => {
    await client.query(
      `INSERT INTO order_item_stations (id,"orderItemId",station,status,"updatedAt") VALUES ($1,$2,'KITCHEN','SUBMITTED',now())`,
      [randomUUID(), orderItemId]
    );
    await client.query(`DELETE FROM order_items WHERE id=$1`, [orderItemId]);
    const states = await client.query(`SELECT id FROM order_item_stations WHERE "orderItemId"=$1`, [orderItemId]);
    expect(states.rows).toHaveLength(0);
  });

  it("backfills legacy dual-station and NONE items without changing cancelled NONE items", async () => {
    await client.query(`UPDATE order_items SET status='PREPARING' WHERE id=$1`, [orderItemId]);
    const noneItemId = randomUUID();
    const cancelledNoneItemId = randomUUID();
    await client.query(
      `INSERT INTO order_items (id,"orderId",name,price,"taxRate","preparationStation",status,"updatedAt")
       VALUES ($1,$3,'No prep',10,20,'NONE','ACCEPTED',now()),
              ($2,$3,'Cancelled',10,20,'NONE','CANCELLED',now())`,
      [noneItemId, cancelledNoneItemId, orderId]
    );

    // Equivalent combined form of the two station backfill statements used by
    // the Phase 1 migration.
    await client.query(
      `INSERT INTO order_item_stations (id,"orderItemId",station,status,"createdAt","updatedAt")
       SELECT md5(random()::text || clock_timestamp()::text || oi.id), oi.id,
              station::"ProductionStation", oi.status, now(), now()
       FROM order_items oi
       CROSS JOIN (VALUES ('KITCHEN'),('BAR')) AS required(station)
       WHERE oi.id=$1`,
      [orderItemId]
    );
    await client.query(
      `UPDATE order_items SET status='SERVED',"updatedAt"=now()
       WHERE status NOT IN ('DRAFT','CANCELLED') AND "preparationStation"='NONE'`
    );

    const states = await client.query(
      `SELECT station,status FROM order_item_stations WHERE "orderItemId"=$1 ORDER BY station::text`,
      [orderItemId]
    );
    expect(states.rows).toEqual([
      { station: "BAR", status: "PREPARING" },
      { station: "KITCHEN", status: "PREPARING" },
    ]);
    const noneRows = await client.query(`SELECT id,status FROM order_items WHERE id IN ($1,$2) ORDER BY id`, [noneItemId, cancelledNoneItemId]);
    expect(noneRows.rows.find((row) => row.id === noneItemId)?.status).toBe("SERVED");
    expect(noneRows.rows.find((row) => row.id === cancelledNoneItemId)?.status).toBe("CANCELLED");
  });
});
