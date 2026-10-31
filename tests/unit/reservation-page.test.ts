import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@rcs/auth";
import { ADMIN_ROLES, WAITER_ROLES } from "@rcs/shared";
import { reservationPageProps } from "../../apps/web/lib/reservation-page";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), restaurant: vi.fn(), locations: vi.fn() }));
vi.mock("../../apps/web/lib/route-guard", () => ({ requireRouteAccess: mocks.guard }));
vi.mock("@rcs/db", () => ({ prisma: { restaurant: { findUniqueOrThrow: mocks.restaurant }, location: { findMany: mocks.locations } } }));
vi.mock("../../apps/web/app/waiter/reservations/reservations-client", () => ({ ReservationsClient: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  mocks.guard.mockResolvedValue({ restaurantId: "r1", locationIds: ["l1"], roles: ["MANAGER"], permissions: new Set(["reservations.view", "reservations.manage"]) });
  mocks.restaurant.mockResolvedValue({ timezone: "Europe/Belgrade" });
  mocks.locations.mockResolvedValue([{ id: "l1", name: "Main" }]);
});

describe("reservation page entry points", () => {
  it("Admin page applies existing Admin role guard and mounts the shared client in Admin mode", async () => {
    const { default: Page } = await import("../../apps/web/app/(admin)/reservations/page");
    const page = await Page();
    expect(mocks.guard).toHaveBeenCalledWith(ADMIN_ROLES);
    expect(page.props).toMatchObject({ mode: "admin", canManage: true, timeZone: "Europe/Belgrade", locations: [{ id: "l1", name: "Main" }] });
    expect(mocks.locations).toHaveBeenCalledWith(expect.objectContaining({ where: { restaurantId: "r1", id: { in: ["l1"] } } }));
  });
  it("Waiter entry point retains the existing waiter role guard", async () => {
    const { default: Page } = await import("../../apps/web/app/waiter/reservations/page");
    const page = await Page();
    expect(mocks.guard).toHaveBeenCalledWith(WAITER_ROLES);
    expect(page.props.canManage).toBe(true);
  });
  it("requires view permission before reading restaurant or location metadata", async () => {
    mocks.guard.mockResolvedValue({ permissions: new Set() });
    await expect(reservationPageProps(ADMIN_ROLES)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.restaurant).not.toHaveBeenCalled(); expect(mocks.locations).not.toHaveBeenCalled();
  });
  it("passes read-only access without granting management permission", async () => {
    mocks.guard.mockResolvedValue({ restaurantId: "r1", locationIds: ["l1"], permissions: new Set(["reservations.view"]) });
    expect((await reservationPageProps(ADMIN_ROLES)).canManage).toBe(false);
  });
  it("does not read metadata when the route guard rejects the user", async () => {
    mocks.guard.mockRejectedValue(new ForbiddenError());
    await expect(reservationPageProps(ADMIN_ROLES)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.locations).not.toHaveBeenCalled();
  });
});
