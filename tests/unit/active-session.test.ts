import { describe, expect, it } from "vitest";
import { assertActiveSessionEntities, UnauthorizedError } from "@rcs/auth";

const active = {
  employeeStatus: "ACTIVE",
  userIsActive: true,
  restaurantStatus: "ACTIVE",
  tenantStatus: "ACTIVE",
};

describe("active session entity validation", () => {
  it("accepts an active account, restaurant, and tenant", () => {
    expect(() => assertActiveSessionEntities(active)).not.toThrow();
  });

  it("rejects a disabled user", () => {
    expect(() => assertActiveSessionEntities({ ...active, userIsActive: false })).toThrow(UnauthorizedError);
  });

  it("rejects an inactive restaurant", () => {
    expect(() => assertActiveSessionEntities({ ...active, restaurantStatus: "SUSPENDED" })).toThrow(UnauthorizedError);
  });

  it("rejects an inactive tenant", () => {
    expect(() => assertActiveSessionEntities({ ...active, tenantStatus: "SUSPENDED" })).toThrow(UnauthorizedError);
  });

  it("allows an active PIN-only employee without a User row", () => {
    expect(() => assertActiveSessionEntities({ ...active, userIsActive: null, allowMissingUser: true })).not.toThrow();
  });

  it("rejects a password session whose User row was removed", () => {
    expect(() => assertActiveSessionEntities({ ...active, userIsActive: null })).toThrow(UnauthorizedError);
  });
});
