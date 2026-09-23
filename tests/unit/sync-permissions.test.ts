import { describe, expect, it } from "vitest";
import { NEW_ROLE_GRANTS } from "../../packages/db/prisma/sync-permissions";

// Inventory Phase 2 — INVENTORY_MANAGER was missing "inventory.count" in its
// original grant list (a data-omission bug, not a logic bug: the role name
// promised Inventura access but the grant list simply never listed the
// permission). This asserts the grant list itself, the same source
// sync-permissions.ts writes to every environment, so a future edit that
// again drops this permission from the list fails a test instead of
// silently shipping a role that can't do what its name says.
describe("sync-permissions NEW_ROLE_GRANTS — INVENTORY_MANAGER", () => {
  it("grants inventory.count to INVENTORY_MANAGER", () => {
    expect(NEW_ROLE_GRANTS.INVENTORY_MANAGER).toContain("inventory.count");
  });

  it("still grants workstations.manage to INVENTORY_MANAGER (unrelated P0 grant, must not regress)", () => {
    expect(NEW_ROLE_GRANTS.INVENTORY_MANAGER).toContain("workstations.manage");
  });

  it("also grants inventory.count to OWNER, ADMIN, and MANAGER", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
      expect(NEW_ROLE_GRANTS[role]).toContain("inventory.count");
    }
  });
});
