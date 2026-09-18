import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import type { WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * Faza 2C — Admin "Test Print" dugme. Namerno proverava da OVAJ put NIKAD
 * ne kreira PrintJob/Order (test štampa mora ostati van accounting/
 * izveštaja — vidi requestTestPrint napomenu u workstation-service.ts), da
 * heartbeat vraća zastavicu SAMO dok je status PENDING, i da agent-strana
 * prijava ishoda (recordTestPrintResult) ispravno ažurira status koji
 * Admin panel prikazuje.
 */
let ctx: AuthContext;
let restaurantId: string;
let locationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "TestPrint", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  restaurantId = restaurant.id;
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  ctx = {
    userId: "manager",
    employeeId: "manager",
    restaurantId,
    locationIds: [locationId],
    roles: ["MANAGER"],
    permissions: new Set(["workstations.manage"]),
  };
});

async function pairWorkstation(): Promise<{ workstationId: string; wsCtx: WorkstationAuthContext }> {
  // Printing V2 — pairing no longer carries a station; requestTestPrint now
  // targets a specific WorkstationPrintRoute (a workstation can have
  // several different printers), and refuses a route with no printer
  // chosen yet — so every test below needs a real configured route first.
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
  return {
    workstationId: registered.workstationId,
    wsCtx: { workstationId: registered.workstationId, restaurantId: registered.restaurantId, locationId: registered.locationId, station: registered.station },
  };
}

describe("workstation test print — request/ack lifecycle", () => {
  it("requestTestPrint sets PENDING status (with the requested route type) without creating any PrintJob or touching Order data", async () => {
    const { workstationId } = await pairWorkstation();
    const before = await prisma.printJob.count();

    const updated = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    expect(updated.testPrintStatus).toBe("PENDING");
    expect(updated.testPrintRouteType).toBe("KITCHEN");
    expect(updated.testPrintRequestedAt).toBeInstanceOf(Date);
    expect(updated.testPrintCompletedAt).toBeNull();

    // Sekcija zahteva: "no fake restaurant order/accounting mutation" —
    // proveri da baš ništa u PrintJob tabeli nije nastalo zbog ovoga.
    expect(await prisma.printJob.count()).toBe(before);
  });

  it("rejects a test print request for a route with no printer configured yet", async () => {
    const { workstationId } = await pairWorkstation();
    await expect(workstations.requestTestPrint(ctx, workstationId, "BAR")).rejects.toThrow();
  });

  it("heartbeat reports testPrintRequested=true (with the route type) only while PENDING, and false once acknowledged", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();

    const beforeRequest = await workstations.recordHeartbeat(wsCtx, {});
    expect(beforeRequest.testPrintRequested).toBe(false);
    expect(beforeRequest.testPrintRoute).toBeNull();

    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const afterRequest = await workstations.recordHeartbeat(wsCtx, {});
    expect(afterRequest.testPrintRequested).toBe(true);
    expect(afterRequest.testPrintRoute).toBe("KITCHEN");

    await workstations.recordTestPrintResult(wsCtx, { status: "SUCCEEDED" });
    const afterAck = await workstations.recordHeartbeat(wsCtx, {});
    expect(afterAck.testPrintRequested).toBe(false);
  });

  it("recordTestPrintResult(SUCCEEDED) clears any prior error and stamps completion time", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");

    await workstations.recordTestPrintResult(wsCtx, { status: "SUCCEEDED" });
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } });
    expect(row.testPrintStatus).toBe("SUCCEEDED");
    expect(row.testPrintError).toBeNull();
    expect(row.testPrintCompletedAt).toBeInstanceOf(Date);
  });

  it("recordTestPrintResult(FAILED) stores the agent-reported error for Admin display", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");

    await workstations.recordTestPrintResult(wsCtx, { status: "FAILED", errorMessage: "Konfigurisan štampač nije dostupan." });
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } });
    expect(row.testPrintStatus).toBe("FAILED");
    expect(row.testPrintError).toBe("Konfigurisan štampač nije dostupan.");
  });

  it("rejects a test print request for a revoked workstation", async () => {
    const { workstationId } = await pairWorkstation();
    await workstations.revokeWorkstation(ctx, workstationId);
    await expect(workstations.requestTestPrint(ctx, workstationId, "KITCHEN")).rejects.toThrow();
  });

  it("rejects a test print request for a workstation in another restaurant (tenant isolation)", async () => {
    const { workstationId } = await pairWorkstation();
    const otherCtx: AuthContext = { ...ctx, restaurantId: randomUUID(), locationIds: [] };
    await expect(workstations.requestTestPrint(otherCtx, workstationId, "KITCHEN")).rejects.toThrow();
  });

  it("a second requestTestPrint while one is still PENDING simply resets the same PENDING state (no duplicate accumulation)", async () => {
    const { workstationId } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const second = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    expect(second.testPrintStatus).toBe("PENDING");
  });
});

describe("agent download info — no binary in the database", () => {
  it("reports unavailable (not a broken/fabricated URL) when no installer URL is configured", () => {
    delete process.env.PRINT_AGENT_INSTALLER_URL;
    const info = workstations.getAgentDownloadInfo(ctx);
    expect(info.available).toBe(false);
    expect(info.url).toBeNull();
    expect(info.version).toBe("1.0.0-rc.2");
  });

  it("reports the configured URL when PRINT_AGENT_INSTALLER_URL is set, without ever touching the database", () => {
    process.env.PRINT_AGENT_INSTALLER_URL = "https://example-releases.invalid/TableCorePrintSetup.exe";
    try {
      const info = workstations.getAgentDownloadInfo(ctx);
      expect(info.available).toBe(true);
      expect(info.url).toBe("https://example-releases.invalid/TableCorePrintSetup.exe");
    } finally {
      delete process.env.PRINT_AGENT_INSTALLER_URL;
    }
  });
});
