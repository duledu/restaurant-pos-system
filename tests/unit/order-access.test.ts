import { describe, expect, it } from "vitest";
import { ForbiddenError, requireLocationAccess, type AuthContext } from "@rcs/auth";
import { requireDraftOwnership, requireOrderOperator } from "../../packages/domain/orders/order-access";

function context(role: string, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: "restaurant-1",
    locationIds: ["location-1"],
    roles: [role],
    permissions: new Set(),
  };
}

describe("waiter order authorization", () => {
  it("allows a waiter to operate their own draft", () => {
    expect(() => requireDraftOwnership(context("WAITER"), "waiter-1")).not.toThrow();
  });

  it("rejects a waiter modifying another waiter's draft", () => {
    expect(() => requireDraftOwnership(context("WAITER"), "waiter-2")).toThrow(ForbiddenError);
  });

  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s management override", (role) => {
    expect(() => requireDraftOwnership(context(role, "manager-1"), "waiter-1")).not.toThrow();
  });

  it.each(["KITCHEN", "BAR"])("rejects %s order mutations", (role) => {
    expect(() => requireOrderOperator(context(role))).toThrow(ForbiddenError);
    expect(() => requireDraftOwnership(context(role), "waiter-1")).toThrow(ForbiddenError);
  });

  it("preserves cross-location rejection", () => {
    expect(() => requireLocationAccess(context("WAITER"), "location-2")).toThrow(ForbiddenError);
  });
});
