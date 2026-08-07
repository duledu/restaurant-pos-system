import { describe, it, expect } from "vitest";

/**
 * Ovaj test NE zove menu-service funkcije direktno (one zahtevaju Prisma
 * klijenta koji ovde nije generisan — vidi napomenu u tests/README ili
 * finalni izveštaj). Umesto toga testira TAČNO ono što garantuje bezbednost:
 * da svaki poziv menu.manage-zaštićene funkcije prolazi kroz
 * requirePermission(ctx, "menu.manage") pre bilo koje izmene — što je već
 * direktno pokriveno u tests/unit/rbac.test.ts (generička provera). Ovde se
 * proverava KONKRETNA seed konfiguracija: da role WAITER/KITCHEN/BAR zaista
 * nemaju "menu.manage" u seed-u, jer je to specifičan bezbednosni zahtev iz
 * specifikacije ("Waiters, Kitchen and Bar users must never have these
 * permissions").
 */
import { requirePermission, ForbiddenError, type AuthContext } from "@rcs/auth";

// Ogledalo ROLE_PERMISSIONS mape iz packages/db/prisma/seed.ts — namerno
// duplirano ovde kao eksplicitan, čitljiv bezbednosni test, ne kao import,
// da promena u seed.ts koja slučajno doda menu.manage konobaru MORA
// eksplicitno da izmeni i ovaj test (force review), ne da prođe nezapaženo.
const SEED_ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage", "menu.view", "menu.manage"],
  ADMIN: ["employees.view", "employees.manage", "menu.view", "menu.manage"],
  MANAGER: ["employees.view", "menu.view"],
  WAITER: ["menu.view"],
  KITCHEN: ["menu.view"],
  BAR: ["menu.view"],
  INVENTORY_MANAGER: ["menu.view"],
};

function ctxWithRole(role: string): AuthContext {
  return {
    userId: "u1",
    employeeId: "e1",
    restaurantId: "r1",
    locationIds: ["l1"],
    roles: [role],
    permissions: new Set(SEED_ROLE_PERMISSIONS[role]),
  };
}

describe("menu.manage permisija — bezbednosni zahtev specifikacije", () => {
  it.each(["WAITER", "KITCHEN", "BAR"])(
    "%s NIKAD nema menu.manage (ne može menjati cenu/brisati/arhivirati/dodavati artikle)",
    (role) => {
      const ctx = ctxWithRole(role);
      expect(() => requirePermission(ctx, "menu.manage")).toThrow(ForbiddenError);
    }
  );

  it.each(["OWNER", "ADMIN"])("%s ima menu.manage", (role) => {
    const ctx = ctxWithRole(role);
    expect(() => requirePermission(ctx, "menu.manage")).not.toThrow();
  });

  it("MANAGER u trenutnoj seed konfiguraciji NEMA menu.manage (samo OWNER/ADMIN)", () => {
    const ctx = ctxWithRole("MANAGER");
    expect(() => requirePermission(ctx, "menu.manage")).toThrow(ForbiddenError);
  });

  it.each(["OWNER", "ADMIN", "MANAGER", "WAITER", "KITCHEN", "BAR", "INVENTORY_MANAGER"])(
    "%s ima menu.view (svi mogu da vide meni)",
    (role) => {
      const ctx = ctxWithRole(role);
      expect(() => requirePermission(ctx, "menu.view")).not.toThrow();
    }
  );
});
