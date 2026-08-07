/**
 * Testira TAČAN SQL obrazac koji seed-menu.ts koristi (Prisma upsert po
 * @@unique([restaurantId, slug]) se svodi na INSERT ... ON CONFLICT DO
 * UPDATE) — protiv realnog Postgres-a, ne mock-a. Dokazuje zahtev "Running
 * the seed multiple times MUST NOT create duplicates".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://rcs:rcs_dev_password@localhost:5432/rcs_dev?schema=public";

let client: Client;
let restaurantId: string;

beforeAll(async () => {
  client = new Client({ connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(
    `TRUNCATE tenants, restaurants, menu_categories, menu_items CASCADE`
  );
  const tenantId = randomUUID();
  restaurantId = randomUUID();
  await client.query(`INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1,'T','t-'||$1, now())`, [
    tenantId,
  ]);
  await client.query(`INSERT INTO restaurants (id, "tenantId", name, "updatedAt") VALUES ($1,$2,'R', now())`, [
    restaurantId,
    tenantId,
  ]);
});

async function upsertCategory(name: string, slug: string, sortOrder: number) {
  await client.query(
    `INSERT INTO menu_categories (id, "restaurantId", name, slug, type, "sortOrder", "updatedAt")
     VALUES ($1,$2,$3,$4,'FOOD',$5, now())
     ON CONFLICT ("restaurantId", slug)
     DO UPDATE SET name = EXCLUDED.name, "sortOrder" = EXCLUDED."sortOrder", "updatedAt" = now()`,
    [randomUUID(), restaurantId, name, slug, sortOrder]
  );
}

async function upsertItem(name: string, slug: string, price: number) {
  await client.query(
    `INSERT INTO menu_items (id, "restaurantId", name, slug, price, "updatedAt")
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT ("restaurantId", slug)
     DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, "updatedAt" = now()`,
    [randomUUID(), restaurantId, name, slug, price]
  );
}

describe("Menu seed UPSERT idempotentnost", () => {
  it("pokretanje upserta 3 puta za istu kategoriju ne pravi duplikate", async () => {
    await upsertCategory("Grill", "grill", 3);
    await upsertCategory("Grill", "grill", 3);
    await upsertCategory("Grill", "grill", 3);

    const result = await client.query(`SELECT * FROM menu_categories WHERE "restaurantId" = $1`, [restaurantId]);
    expect(result.rows).toHaveLength(1);
  });

  it("ponovni upsert sa promenjenim nazivom AŽURIRA postojeći red, ne pravi novi", async () => {
    await upsertCategory("Grill", "grill", 3);
    await upsertCategory("Roštilj (ispravljeno)", "grill", 3);

    const result = await client.query(`SELECT name FROM menu_categories WHERE "restaurantId" = $1`, [restaurantId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Roštilj (ispravljeno)");
  });

  it("16 kategorija uvezenih 2 puta zaredom rezultira tačno 16 redova", async () => {
    const categories = [
      "Breakfast", "Cold Appetizers", "Hot Appetizers", "Grill", "Made To Order",
      "Salads", "Winter Salads", "Fish", "Bread", "Desserts",
      "Hot Drinks", "Soft Drinks", "Water", "Beer", "Spirits", "Wine",
    ];
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    for (let pass = 0; pass < 2; pass++) {
      for (const [i, name] of categories.entries()) {
        await upsertCategory(name, slugify(name), i);
      }
    }

    const result = await client.query(`SELECT count(*) FROM menu_categories WHERE "restaurantId" = $1`, [
      restaurantId,
    ]);
    expect(Number(result.rows[0].count)).toBe(16);
  });

  it("artikal upsertovan dva puta ne duplira se, i cena se ažurira na poslednju vrednost", async () => {
    await upsertItem("Ramstek", "ramstek", 0);
    await upsertItem("Ramstek", "ramstek", 1290);

    const result = await client.query(`SELECT price FROM menu_items WHERE "restaurantId" = $1 AND slug = 'ramstek'`, [
      restaurantId,
    ]);
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].price)).toBe(1290);
  });

  it("dva različita artikla sa različitim slug-ovima koegzistiraju bez konflikta", async () => {
    await upsertItem("Ramstek", "ramstek", 0);
    await upsertItem("Teletina u sosu", "teletina-u-sosu", 0);

    const result = await client.query(`SELECT count(*) FROM menu_items WHERE "restaurantId" = $1`, [restaurantId]);
    expect(Number(result.rows[0].count)).toBe(2);
  });

  it("uvoz svih 137 artikala zvaničnog menija je idempotentan (2 prolaza = i dalje 137 redova)", async () => {
    const seedModule = await import("../../packages/db/prisma/seed-menu-data");
    const allItemNames = Object.values(seedModule.MENU_BY_CATEGORY).flat();
    expect(allItemNames.length).toBe(137);

    const slugify = (s: string) =>
      s
        .toLowerCase()
        .replace(/[čć]/g, "c")
        .replace(/š/g, "s")
        .replace(/ž/g, "z")
        .replace(/đ/g, "dj")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

    for (let pass = 0; pass < 2; pass++) {
      for (const name of allItemNames) {
        await upsertItem(name, slugify(name), 0);
      }
    }

    const result = await client.query(`SELECT count(*) FROM menu_items WHERE "restaurantId" = $1`, [restaurantId]);
    expect(Number(result.rows[0].count)).toBe(137);
  });
});
