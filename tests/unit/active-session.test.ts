import { describe, expect, it } from "vitest";
import { assertActiveSessionEntities, assertActiveDevice, shouldRefreshLastSeen, UnauthorizedError } from "@rcs/auth";

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

describe("assertActiveDevice", () => {
  const restaurantId = "rest-1";

  it("accepts an active device belonging to the expected restaurant", () => {
    expect(() => assertActiveDevice({ restaurantId, isActive: true, lastSeenAt: null }, restaurantId)).not.toThrow();
  });

  it("rejects a null device (no such device / not found)", () => {
    expect(() => assertActiveDevice(null, restaurantId)).toThrow(UnauthorizedError);
  });

  it("rejects a revoked device", () => {
    expect(() => assertActiveDevice({ restaurantId, isActive: false, lastSeenAt: null }, restaurantId)).toThrow(UnauthorizedError);
  });

  it("rejects a device belonging to a different restaurant than the session claims", () => {
    expect(() => assertActiveDevice({ restaurantId: "other-rest", isActive: true, lastSeenAt: null }, restaurantId)).toThrow(
      UnauthorizedError
    );
  });
});

describe("shouldRefreshLastSeen", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("is true when lastSeenAt is null (never seen)", () => {
    expect(shouldRefreshLastSeen(null, now)).toBe(true);
  });

  it("is false when lastSeenAt is within the ~5 minute throttle window", () => {
    const recent = new Date(now.getTime() - 4 * 60 * 1000);
    expect(shouldRefreshLastSeen(recent, now)).toBe(false);
  });

  it("is true when lastSeenAt is older than the throttle window", () => {
    const stale = new Date(now.getTime() - 6 * 60 * 1000);
    expect(shouldRefreshLastSeen(stale, now)).toBe(true);
  });

  it("is false exactly at the boundary (not yet strictly older)", () => {
    const boundary = new Date(now.getTime() - 5 * 60 * 1000);
    expect(shouldRefreshLastSeen(boundary, now)).toBe(false);
  });
});
