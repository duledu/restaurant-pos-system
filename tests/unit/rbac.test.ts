import { describe, it, expect } from "vitest";
import {
  requirePermission,
  requireLocationAccess,
  scopeToRestaurant,
  ForbiddenError,
  type AuthContext,
} from "@rcs/auth";

function makeCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "u1",
    employeeId: "e1",
    restaurantId: "r1",
    locationIds: ["l1"],
    roles: ["WAITER"],
    permissions: new Set(["order.create"]),
    ...overrides,
  };
}

describe("requirePermission", () => {
  it("prolazi kada kontekst ima traženu permisiju", () => {
    const ctx = makeCtx();
    expect(() => requirePermission(ctx, "order.create")).not.toThrow();
  });

  it("baca ForbiddenError kada permisija nedostaje", () => {
    const ctx = makeCtx();
    expect(() => requirePermission(ctx, "inventory.adjust")).toThrow(ForbiddenError);
  });
});

describe("requireLocationAccess", () => {
  it("prolazi za dozvoljenu lokaciju", () => {
    const ctx = makeCtx({ locationIds: ["l1", "l2"] });
    expect(() => requireLocationAccess(ctx, "l2")).not.toThrow();
  });

  it("baca ForbiddenError za nedozvoljenu lokaciju", () => {
    const ctx = makeCtx({ locationIds: ["l1"] });
    expect(() => requireLocationAccess(ctx, "l99")).toThrow(ForbiddenError);
  });
});

describe("scopeToRestaurant", () => {
  it("vraća filter isključivo sa restaurantId iz konteksta, ne iz spoljašnjeg izvora", () => {
    const ctx = makeCtx({ restaurantId: "r-real" });
    expect(scopeToRestaurant(ctx)).toEqual({ restaurantId: "r-real" });
  });
});
