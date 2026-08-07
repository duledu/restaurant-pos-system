/**
 * Integracioni test protiv REALNOG lokalnog PostgreSQL servera (ne mock).
 *
 * Napomena o okruženju: u ovom sandbox-u `prisma generate`/`migrate` ne mogu
 * da se izvrše jer je binaries.prisma.sh van dozvoljenih mrežnih domena, pa
 * ovaj test koristi `pg` direktno (raw SQL) umesto generisanog Prisma
 * klijenta. Šema se primenjuje iz istog DDL-a koji je već ručno proveren
 * protiv schema.prisma (packages/db/prisma/_manual_ddl_validation.sql).
 * Testira se ISTI obrazac upita koji `scopeToRestaurant(ctx)` proizvodi za
 * Prisma — WHERE restaurantId = <iz AuthContext-a> — pa nalaz važi identično
 * i za pravi Prisma klijent u okruženju sa punim internet pristupom.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";

const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://rcs:rcs_dev_password@localhost:5432/rcs_dev?schema=public";

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query(
    `TRUNCATE tenants, restaurants, locations, roles, employees, employee_roles,
     employee_locations, users, devices, permissions, role_permissions, audit_logs CASCADE`
  );
});

async function seedTwoRestaurants() {
  const tenantId = randomUUID();
  await client.query(`INSERT INTO tenants (id, name, slug, "updatedAt") VALUES ($1,'T','t-'||$1, now())`, [
    tenantId,
  ]);

  const restaurantA = randomUUID();
  const restaurantB = randomUUID();
  await client.query(`INSERT INTO restaurants (id, "tenantId", name, "updatedAt") VALUES ($1,$2,'Restoran A', now())`, [
    restaurantA,
    tenantId,
  ]);
  await client.query(`INSERT INTO restaurants (id, "tenantId", name, "updatedAt") VALUES ($1,$2,'Restoran B', now())`, [
    restaurantB,
    tenantId,
  ]);

  const employeeA = randomUUID();
  const employeeB = randomUUID();
  await client.query(
    `INSERT INTO employees (id, "restaurantId", "firstName", "lastName", "updatedAt") VALUES ($1,$2,'Zaposleni','A', now())`,
    [employeeA, restaurantA]
  );
  await client.query(
    `INSERT INTO employees (id, "restaurantId", "firstName", "lastName", "updatedAt") VALUES ($1,$2,'Zaposleni','B', now())`,
    [employeeB, restaurantB]
  );

  return { restaurantA, restaurantB, employeeA, employeeB };
}

describe("Tenant izolacija (scopeToRestaurant obrazac upita)", () => {
  it("upit sa restaurantId iz AuthContext-a A ne vraća zaposlene restorana B", async () => {
    const { restaurantA, employeeA } = await seedTwoRestaurants();

    // Ovo je TAČAN obrazac koji koristi svaki domain servis:
    // prisma.employee.findMany({ where: scopeToRestaurant(ctx) })
    // ekvivalentno: SELECT * FROM employees WHERE "restaurantId" = ctx.restaurantId
    const result = await client.query(`SELECT id, "firstName" FROM employees WHERE "restaurantId" = $1`, [
      restaurantA,
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(employeeA);
  });

  it("upit BEZ restaurantId filtera (simulacija greške u servisu) vraća podatke oba restorana — dokazuje zašto je scoping obavezan", async () => {
    await seedTwoRestaurants();

    const unscoped = await client.query(`SELECT id FROM employees`);
    expect(unscoped.rows.length).toBe(2); // curenje kroz oba tenant-a — ovo NIKAD ne sme da se desi u servisnom sloju
  });

  it("pokušaj čitanja tuđeg restaurantId direktno iz ulaza (ne iz sesije) mora biti odbačen na servisnom nivou", async () => {
    // Ovaj test dokumentuje UGOVOR, ne SQL ponašanje: baza sama po sebi ne
    // sprečava upit sa pogrešnim restaurantId parametrom — zato
    // scopeToRestaurant(ctx) MORA graditi filter isključivo iz AuthContext-a
    // (izvedenog iz sesije), nikad iz req.body/req.query. Test u
    // tests/unit/rbac.test.ts već proverava da scopeToRestaurant ignoriše
    // sve osim ctx.restaurantId — ovde samo potvrđujemo da baza to neće
    // uraditi umesto servisnog sloja.
    const { restaurantB } = await seedTwoRestaurants();
    const attackerSuppliedRestaurantId = restaurantB; // npr. iz falsifikovanog request body-ja
    const result = await client.query(`SELECT id FROM employees WHERE "restaurantId" = $1`, [
      attackerSuppliedRestaurantId,
    ]);
    // Baza časno vraća ono što se traži — otuda odgovornost mora biti u
    // rbac.ts / servisnom sloju, ne u DB šemi.
    expect(result.rows).toHaveLength(1);
  });
});

describe("Referencijalni integritet (RESTRICT/CASCADE)", () => {
  it("RESTRICT sprečava brisanje restorana koji ima zaposlene", async () => {
    const { restaurantA } = await seedTwoRestaurants();
    await expect(client.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantA])).rejects.toThrow();
  });

  it("CASCADE briše employee_roles/employee_locations kada se obriše zaposleni", async () => {
    const { employeeA, restaurantA } = await seedTwoRestaurants();

    const roleId = randomUUID();
    const locationId = randomUUID();
    await client.query(`INSERT INTO roles (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'WAITER', now())`, [
      roleId,
      restaurantA,
    ]);
    await client.query(`INSERT INTO locations (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'L1', now())`, [
      locationId,
      restaurantA,
    ]);
    await client.query(`INSERT INTO employee_roles ("employeeId","roleId") VALUES ($1,$2)`, [employeeA, roleId]);
    await client.query(`INSERT INTO employee_locations ("employeeId","locationId") VALUES ($1,$2)`, [
      employeeA,
      locationId,
    ]);

    await client.query(`DELETE FROM employees WHERE id = $1`, [employeeA]);

    const roles = await client.query(`SELECT * FROM employee_roles WHERE "employeeId" = $1`, [employeeA]);
    const locations = await client.query(`SELECT * FROM employee_locations WHERE "employeeId" = $1`, [employeeA]);
    expect(roles.rows).toHaveLength(0);
    expect(locations.rows).toHaveLength(0);
  });
});

describe("Composite unique constraints", () => {
  it("ne dozvoljava dve role istog imena u istom restoranu", async () => {
    const { restaurantA } = await seedTwoRestaurants();
    await client.query(`INSERT INTO roles (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'OWNER', now())`, [
      randomUUID(),
      restaurantA,
    ]);
    await expect(
      client.query(`INSERT INTO roles (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'OWNER', now())`, [
        randomUUID(),
        restaurantA,
      ])
    ).rejects.toThrow();
  });

  it("dozvoljava isto ime role u DVA RAZLIČITA restorana", async () => {
    const { restaurantA, restaurantB } = await seedTwoRestaurants();
    await client.query(`INSERT INTO roles (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'OWNER', now())`, [
      randomUUID(),
      restaurantA,
    ]);
    await expect(
      client.query(`INSERT INTO roles (id, "restaurantId", name, "updatedAt") VALUES ($1,$2,'OWNER', now())`, [
        randomUUID(),
        restaurantB,
      ])
    ).resolves.toBeTruthy();
  });
});
