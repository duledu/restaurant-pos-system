/**
 * DEV ACCOUNT REPAIR — idempotentno kreiranje/ažuriranje dev naloga.
 *
 * Bezbedno za višestruko pokretanje (upsert/findFirst svuda, bez DELETE).
 * Namenjeno Neon/cloud dev bazi; NE briše ni jednu postojeću evidenciju.
 *
 * Pokreni: npx tsx scripts/dev-repair-accounts.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "crypto";
import { hashPin } from "@rcs/auth";

if (process.env.NODE_ENV === "production") {
  throw new Error("Zabranjeno pokretanje u produkciji.");
}

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${key}`;
}

const SYSTEM_ROLES = ["OWNER", "ADMIN", "MANAGER", "WAITER", "KITCHEN", "BAR", "INVENTORY_MANAGER"] as const;
type SystemRole = (typeof SYSTEM_ROLES)[number];

const PERMISSIONS = [
  { code: "employees.view", description: "Pregled liste zaposlenih" },
  { code: "employees.manage", description: "Kreiranje/izmena zaposlenih, rola i dozvola" },
  { code: "menu.view", description: "Pregled menija (kategorije i artikli)" },
  { code: "menu.manage", description: "Izmena cena, kreiranje/brisanje/arhiviranje artikala i kategorija" },
  { code: "shifts.manage", description: "Otvaranje i zatvaranje smene" },
  { code: "production.view", description: "Pregled tiketa kuhinje/šanka" },
  { code: "production.manage", description: "Promena statusa stavki na kuhinji/šanku" },
  { code: "audit.view", description: "Pregled audit evidencije i sumnjive aktivnosti" },
  { code: "devices.manage", description: "Registracija POS/KDS uređaja" },
] as const;

const ROLE_PERMISSIONS: Record<SystemRole, string[]> = {
  OWNER:              ["employees.view", "employees.manage", "menu.view", "menu.manage", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  ADMIN:              ["employees.view", "employees.manage", "menu.view", "menu.manage", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  MANAGER:            ["employees.view", "menu.view", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  WAITER:             ["menu.view", "shifts.manage"],
  KITCHEN:            ["menu.view", "production.view", "production.manage"],
  BAR:                ["menu.view", "production.view", "production.manage"],
  INVENTORY_MANAGER:  ["menu.view"],
};

const DEV_ACCOUNTS: Array<{
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: SystemRole;
  pin?: string;
}> = [
  { email: "owner@dev.local",    password: "DevOwner123!",   firstName: "Vlasnik",  lastName: "Dev", role: "OWNER" },
  { email: "admin@dev.local",    password: "DevAdmin123!",   firstName: "Admin",    lastName: "Dev", role: "ADMIN" },
  { email: "manager@dev.local",  password: "DevManager123!", firstName: "Menadžer", lastName: "Dev", role: "MANAGER",  pin: "5001" },
  { email: "konobar1@dev.local", password: "DevWaiter123!",  firstName: "Konobar1", lastName: "Dev", role: "WAITER",   pin: "1001" },
  { email: "konobar2@dev.local", password: "DevWaiter223!",  firstName: "Konobar2", lastName: "Dev", role: "WAITER",   pin: "1002" },
  { email: "konobar3@dev.local", password: "DevWaiter323!",  firstName: "Konobar3", lastName: "Dev", role: "WAITER",   pin: "1003" },
  { email: "kuhinja@dev.local",  password: "DevKitchen123!", firstName: "Kuhinja",  lastName: "Dev", role: "KITCHEN",  pin: "2001" },
  { email: "sank@dev.local",     password: "DevBar123!",     firstName: "Šank",     lastName: "Dev", role: "BAR",      pin: "3001" },
];

async function main() {
  console.log("🔧  Dev Account Repair — idempotentno\n");

  // 1. Upsert tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "dev-tenant" },
    create: { name: "Dev Tenant", slug: "dev-tenant" },
    update: { name: "Dev Tenant" },
  });
  console.log(`✓ Tenant: ${tenant.name} (${tenant.id})`);

  // 2. Find or create restaurant
  let restaurant = await prisma.restaurant.findFirst({
    where: { tenantId: tenant.id },
  });
  if (!restaurant) {
    restaurant = await prisma.restaurant.create({
      data: { tenantId: tenant.id, name: "Restoran (Dev)", timezone: "Europe/Belgrade", currency: "RSD" },
    });
    console.log(`✓ Restoran kreiran: ${restaurant.name}`);
  } else {
    console.log(`✓ Restoran pronađen: ${restaurant.name} (${restaurant.id})`);
  }

  // 3. Find or create location
  let location = await prisma.location.findFirst({
    where: { restaurantId: restaurant.id },
  });
  if (!location) {
    location = await prisma.location.create({
      data: { restaurantId: restaurant.id, name: "Glavna lokacija" },
    });
    console.log(`✓ Lokacija kreirana: ${location.name}`);
  } else {
    console.log(`✓ Lokacija pronađena: ${location.name}`);
  }

  // 3b. Ensure at least one floor + tables exist for this location — the
  // original one-shot seed.ts always created "Glavna sala" + 10 tables, but
  // this repair script previously did not, so a restaurant repaired by this
  // script alone ended up with zero floors/tables (waiter sees an empty
  // table grid even though everything else — auth/shift/location — is
  // correct). Idempotent: only creates when none exist yet, never touches
  // an existing floor/table (so real dev table edits are never overwritten).
  let floor = await prisma.floor.findFirst({
    where: { restaurantId: restaurant.id, locationId: location.id },
  });
  if (!floor) {
    floor = await prisma.floor.create({
      data: { restaurantId: restaurant.id, locationId: location.id, name: "Glavna sala" },
    });
    await prisma.restaurantTable.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        floorId: floor!.id,
        label: `Sto ${i + 1}`,
        capacity: 4,
      })),
    });
    console.log(`✓ Sala kreirana: ${floor.name} (10 stolova)`);
  } else {
    const tableCount = await prisma.restaurantTable.count({ where: { floorId: floor.id } });
    console.log(`✓ Sala pronađena: ${floor.name} (${tableCount} stolova)`);
  }

  // 4. Upsert permissions
  const permMap: Record<string, string> = {};
  for (const p of PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      create: p,
      update: {},
    });
    permMap[p.code] = perm.id;
  }
  console.log(`✓ Permisije: ${Object.keys(permMap).length} upsert-ovano`);

  // 5. Find or create roles for THIS restaurant
  const roleMap: Record<string, string> = {};
  for (const roleName of SYSTEM_ROLES) {
    let role = await prisma.role.findFirst({
      where: { restaurantId: restaurant.id, name: roleName },
    });
    if (!role) {
      role = await prisma.role.create({
        data: { restaurantId: restaurant.id, name: roleName, isSystem: true },
      });
    }
    roleMap[roleName] = role.id;

    // Ensure role permissions exist (createMany skipDuplicates)
    const codes = ROLE_PERMISSIONS[roleName];
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({
        data: codes.map((code) => ({ roleId: role!.id, permissionId: permMap[code] })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`✓ Role: ${SYSTEM_ROLES.length} upsert-ovano`);

  // 6. Create/update each dev account
  console.log("\n📋  Dev nalozi:");
  for (const acc of DEV_ACCOUNTS) {
    const existingUser = await prisma.user.findUnique({ where: { email: acc.email } });

    let userId: string;
    if (existingUser) {
      // Update password only — do not touch other fields
      const updated = await prisma.user.update({
        where: { id: existingUser.id },
        data: { passwordHash: hashPassword(acc.password), isActive: true },
      });
      userId = updated.id;
      process.stdout.write(`  ↻ ${acc.email} — lozinka ažurirana`);
    } else {
      const user = await prisma.user.create({
        data: { email: acc.email, passwordHash: hashPassword(acc.password), isActive: true },
      });
      userId = user.id;
      process.stdout.write(`  + ${acc.email} — kreiran`);
    }

    // Find or create employee linked to this user
    let employee = await prisma.employee.findFirst({
      where: { restaurantId: restaurant.id, userId },
    });

    if (!employee) {
      // Also check if an employee exists with this userId in any restaurant
      const anyEmployee = await prisma.employee.findFirst({ where: { userId } });
      if (anyEmployee && anyEmployee.restaurantId === restaurant.id) {
        employee = anyEmployee;
      } else if (!anyEmployee) {
        employee = await prisma.employee.create({
          data: {
            restaurantId: restaurant.id,
            userId,
            firstName: acc.firstName,
            lastName: acc.lastName,
            status: "ACTIVE",
            pinHash: acc.pin ? await hashPin(acc.pin) : undefined,
          },
        });
      } else {
        // Employee exists for a different restaurant — create new one for dev restaurant
        employee = await prisma.employee.create({
          data: {
            restaurantId: restaurant.id,
            userId,
            firstName: acc.firstName,
            lastName: acc.lastName,
            status: "ACTIVE",
            pinHash: acc.pin ? await hashPin(acc.pin) : undefined,
          },
        });
      }
      console.log(` → zaposleni kreiran`);
    } else {
      // Ensure employee is ACTIVE
      await prisma.employee.update({
        where: { id: employee.id },
        data: { status: "ACTIVE" },
      });
      console.log(` → zaposleni pronađen (aktivan)`);
    }

    // Ensure location assignment
    await prisma.employeeLocation.upsert({
      where: { employeeId_locationId: { employeeId: employee.id, locationId: location.id } },
      create: { employeeId: employee.id, locationId: location.id },
      update: {},
    });

    // Ensure role assignment
    const roleId = roleMap[acc.role];
    await prisma.employeeRole.upsert({
      where: { employeeId_roleId: { employeeId: employee.id, roleId } },
      create: { employeeId: employee.id, roleId },
      update: {},
    });
  }

  console.log("\n✅  Repair završen.");
  console.log("\n   Dev kredencijali:");
  for (const acc of DEV_ACCOUNTS) {
    console.log(`   ${acc.email} / ${acc.password}${acc.pin ? ` (PIN: ${acc.pin})` : ""}`);
  }
  console.log(`\n   restaurantId: ${restaurant.id}`);
  console.log(`   locationId:   ${location.id}`);
}

main()
  .catch((e) => {
    console.error("❌ Greška:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
