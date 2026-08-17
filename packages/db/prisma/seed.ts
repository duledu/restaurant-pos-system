/**
 * DEV-ONLY seed podaci. NE koristiti u produkciji — kredencijali ispod su
 * javni i namenjeni isključivo lokalnom razvoju.
 *
 * Uvozi samo Fazu 1 (tenant/restoran/lokacija/zaposleni/role/permisije).
 * Meni se uvozi ODVOJENO skriptom seed-menu.ts (idempotentan UPSERT —
 * vidi taj fajl za objašnjenje zašto je namerno odvojen od ove skripte).
 */
import { PrismaClient } from "@prisma/client";
import { hashPin } from "@rcs/auth";
import { randomBytes, scryptSync } from "crypto";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${key}`;
}

const SYSTEM_ROLES = [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "WAITER",
  "KITCHEN",
  "BAR",
  "INVENTORY_MANAGER",
] as const;

// Katalog permisija — proširuje se kroz faze. Svaki domain servis referencira
// kod (npr. "menu.manage") iz ove liste; ako servis koristi kod koji ovde
// nije definisan, requirePermission() će ga jednostavno odbiti za sve role
// (fail-closed, ne fail-open) dok se permisija ne doda ovde.
const PERMISSIONS = [
  { code: "employees.view", description: "Pregled liste zaposlenih" },
  { code: "employees.manage", description: "Kreiranje/izmena zaposlenih, rola i dozvola" },
  { code: "menu.view", description: "Pregled menija (kategorije i artikli)" },
  { code: "menu.manage", description: "Izmena cena, kreiranje/brisanje/arhiviranje artikala i kategorija" },
  { code: "shifts.manage", description: "Otvaranje i zatvaranje smene" },
  { code: "production.view", description: "Pregled tiketa kuhinje/šanka" },
  { code: "production.manage", description: "Promena statusa stavki na kuhinji/šanku" },
  { code: "audit.view", description: "Pregled audit evidencije i sumnjive aktivnosti (Faza 4/5)" },
  { code: "devices.manage", description: "Registracija POS/KDS uređaja i podešavanje Deljenog POS režima" },
] as const;

// Ko dobija koju permisiju — MVP je namerno grub (role → skup permisija),
// bez UI-ja za fino podešavanje (to je extension point za punu verziju).
// Ključno pravilo iz specifikacije: WAITER/KITCHEN/BAR NIKAD ne dobijaju
// menu.manage niti employees.manage.
const ROLE_PERMISSIONS: Record<(typeof SYSTEM_ROLES)[number], string[]> = {
  OWNER: ["employees.view", "employees.manage", "menu.view", "menu.manage", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  ADMIN: ["employees.view", "employees.manage", "menu.view", "menu.manage", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  MANAGER: ["employees.view", "menu.view", "shifts.manage", "production.view", "production.manage", "audit.view", "devices.manage"],
  WAITER: ["menu.view", "shifts.manage"],
  KITCHEN: ["menu.view", "production.view", "production.manage"],
  BAR: ["menu.view", "production.view", "production.manage"],
  INVENTORY_MANAGER: ["menu.view"],
};

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed.ts kreira javno poznate dev kredencijale — zabranjeno pokretanje sa NODE_ENV=production.");
  }
  console.log("⚠️  DEV SEED — nije za produkciju.");

  const tenant = await prisma.tenant.create({
    data: { name: "Dev Tenant", slug: "dev-tenant" },
  });

  const restaurant = await prisma.restaurant.create({
    data: {
      tenantId: tenant.id,
      name: "Restoran (Dev)",
      timezone: "Europe/Belgrade",
      currency: "RSD",
    },
  });

  const location = await prisma.location.create({
    data: { restaurantId: restaurant.id, name: "Glavna lokacija" },
  });

  const floor = await prisma.floor.create({
    data: { restaurantId: restaurant.id, locationId: location.id, name: "Glavna sala" },
  });
  await prisma.restaurantTable.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      floorId: floor.id,
      label: `Sto ${i + 1}`,
      capacity: 4,
    })),
  });

  const permissions = await Promise.all(
    PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permissionByCode = Object.fromEntries(permissions.map((p) => [p.code, p]));

  const roles = await Promise.all(
    SYSTEM_ROLES.map((name) =>
      prisma.role.create({
        data: { restaurantId: restaurant.id, name, isSystem: true },
      })
    )
  );
  const roleByName = Object.fromEntries(roles.map((r) => [r.name, r])) as Record<
    (typeof SYSTEM_ROLES)[number],
    (typeof roles)[number]
  >;

  for (const role of roles) {
    const codes = ROLE_PERMISSIONS[role.name as (typeof SYSTEM_ROLES)[number]];
    await prisma.rolePermission.createMany({
      data: codes.map((code) => ({ roleId: role.id, permissionId: permissionByCode[code].id })),
    });
  }

  async function createUserEmployee(params: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: (typeof SYSTEM_ROLES)[number];
    pin?: string;
  }) {
    const user = await prisma.user.create({
      data: { email: params.email, passwordHash: hashPassword(params.password) },
    });
    const employee = await prisma.employee.create({
      data: {
        restaurantId: restaurant.id,
        userId: user.id,
        firstName: params.firstName,
        lastName: params.lastName,
        pinHash: params.pin ? await hashPin(params.pin) : undefined,
      },
    });
    await prisma.employeeLocation.create({
      data: { employeeId: employee.id, locationId: location.id },
    });
    await prisma.employeeRole.create({
      data: { employeeId: employee.id, roleId: roleByName[params.role].id },
    });
    return employee;
  }

  await createUserEmployee({
    email: "owner@dev.local",
    password: "DevOwner123!",
    firstName: "Vlasnik",
    lastName: "Dev",
    role: "OWNER",
  });
  await createUserEmployee({
    email: "admin@dev.local",
    password: "DevAdmin123!",
    firstName: "Admin",
    lastName: "Dev",
    role: "ADMIN",
  });
  await createUserEmployee({
    email: "manager@dev.local",
    password: "DevManager123!",
    firstName: "Menadžer",
    lastName: "Dev",
    role: "MANAGER",
    pin: "5001",
  });

  for (let i = 1; i <= 3; i++) {
    await createUserEmployee({
      email: `konobar${i}@dev.local`,
      password: `DevWaiter${i}23!`,
      firstName: `Konobar${i}`,
      lastName: "Dev",
      role: "WAITER",
      pin: `100${i}`,
    });
  }

  await createUserEmployee({
    email: "kuhinja@dev.local",
    password: "DevKitchen123!",
    firstName: "Kuhinja",
    lastName: "Dev",
    role: "KITCHEN",
    pin: "2001",
  });

  await createUserEmployee({
    email: "sank@dev.local",
    password: "DevBar123!",
    firstName: "Šank",
    lastName: "Dev",
    role: "BAR",
    pin: "3001",
  });

  console.log("✅ Faza 1 seed završen.");
  console.log("   Owner login: owner@dev.local / DevOwner123!");
  console.log("   Konobar PIN primer: 1001 (Konobar1)");
  console.log(`   restaurantId za seed-menu.ts: ${restaurant.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
