import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import type { WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";
import { POST as heartbeatApi } from "../../apps/web/app/api/agent/heartbeat/route";
import { POST as pollApi } from "../../apps/web/app/api/agent/poll/route";
import { POST as claimApi } from "../../apps/web/app/api/agent/test-print/claim/route";
import { POST as resultApi } from "../../apps/web/app/api/agent/test-print/result/route";
import { GET as diagnosticsApi } from "../../apps/web/app/api/agent/diagnostics/route";

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

async function pairWorkstation(): Promise<{ workstationId: string; credential: string; wsCtx: WorkstationAuthContext }> {
  // Printing V2 — pairing no longer carries a station; requestTestPrint now
  // targets a specific WorkstationPrintRoute (a workstation can have
  // several different printers), and refuses a route with no printer
  // chosen yet — so every test below needs a real configured route first.
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code, agentVersion: "1.0.0-rc.3" });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
  await workstations.recordHeartbeat({ workstationId: registered.workstationId, restaurantId: registered.restaurantId,
    locationId: registered.locationId, station: registered.station }, { agentVersion: "1.0.0-rc.4" });
  return {
    credential: registered.credential,
    workstationId: registered.workstationId,
    wsCtx: { workstationId: registered.workstationId, restaurantId: registered.restaurantId, locationId: registered.locationId, station: registered.station },
  };
}

async function finishTest(wsCtx: WorkstationAuthContext, status: "SUCCEEDED" | "FAILED", errorMessage?: string) {
  const request = await workstations.isTestPrintPending(wsCtx);
  expect(await workstations.claimTestPrint(wsCtx, request.requestId!)).toBe(true);
  await workstations.recordTestPrintResult(wsCtx, { requestId: request.requestId!, status, errorMessage });
}

describe("workstation test print — request/ack lifecycle", () => {
  it.each(["missing-id", "missing-route"])("fails an incomplete legacy request (%s) without emitting an unclaimable signal", async (missing) => {
    const { workstationId, credential } = await pairWorkstation();
    await prisma.workstation.update({ where: { id: workstationId }, data: { testPrintStatus: "PENDING",
      testPrintRequestedAt: missing === "missing-id" ? null : new Date(), testPrintRouteType: missing === "missing-route" ? null : "KITCHEN" } });
    const request = new Request("https://preprod.invalid/api/agent/poll", { method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "X-TableCore-Test-Protocol": "2" }, body: "{}" });
    const response = await pollApi(request, { params: {} });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.testPrintRequested).toBe(false);
    expect(body.testPrintRequestId).toBeNull();
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } });
    expect(row.testPrintStatus).toBe("FAILED");
    expect(row.testPrintError).toContain("identitet ili rutu");
  });

  it.each([null, new Date(Date.now() - 121_000)])("rejects a new test immediately when agent contact is missing/stale", async (lastSeenAt) => {
    const { workstationId } = await pairWorkstation();
    await prisma.workstation.update({ where: { id: workstationId }, data: { lastSeenAt } });
    await expect(workstations.requestTestPrint(ctx, workstationId, "KITCHEN")).rejects.toThrow("svež kontakt");
    expect((await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } })).testPrintStatus).toBeNull();
  });

  it("rejects a recently reported service-printer visibility failure without changing mappings", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.recordHeartbeat(wsCtx, { routes: [{ type: "KITCHEN", printerAvailable: false, visible: false }] });
    await expect(workstations.requestTestPrint(ctx, workstationId, "KITCHEN")).rejects.toThrow("ne vidi štampač");
    const route = await prisma.workstationPrintRoute.findUniqueOrThrow({ where: { workstationId_type: { workstationId, type: "KITCHEN" } } });
    expect(route.printerName).toBe("POS-58");
    expect(route.paperWidthMm).toBe(58);
  });

  it("diagnostics authenticate, report protocol and own identity, and cannot claim or alter a pending request", async () => {
    const { workstationId, credential, wsCtx } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const request = (token: string) => new Request("http://localhost:3000/api/agent/diagnostics?workstationId=foreign", { headers: { Authorization: `Bearer ${token}` } });
    expect((await diagnosticsApi(request("invalid"), { params: {} })).status).toBe(401);
    const before = await workstations.getAgentDiagnostics(wsCtx);
    const response = await diagnosticsApi(request(credential), { params: {} });
    const data = await response.json();
    expect(data.serverOrigin).toBe("http://localhost:3000");
    expect(data.testPrintProtocol).toBe(2);
    expect(data.workstation.id).toBe(workstationId);
    expect(data.workstation.restaurantId).toBe(restaurantId);
    expect(data.workstation.locationId).toBe(locationId);
    expect(JSON.stringify(data)).not.toMatch(/credential|codeHash|password|secret/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await workstations.getAgentDiagnostics(wsCtx)).toEqual(before);
    await expect(workstations.getAgentDiagnostics({ ...wsCtx, restaurantId: randomUUID() })).rejects.toThrow();
  });

  it("accepts rc.3 build metadata and creates a fresh request after an expired pending request without a list refresh", async () => {
    const { workstationId } = await pairWorkstation();
    await prisma.workstation.update({ where: { id: workstationId }, data: { agentVersion: "1.0.0-rc.3+abc123",
      testPrintStatus: "PENDING", testPrintRequestedAt: new Date(Date.now() - 91_000), testPrintRouteType: "BAR" } });
    const next = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    expect(next.testPrintStatus).toBe("PENDING");
    expect(next.testPrintRouteType).toBe("KITCHEN");
    expect(next.testPrintRequestedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it.each(["KITCHEN", "BAR", "RECEIPT"] as const)("traces %s request -> authenticated poll -> one claim -> ACK through the real API handlers and database", async (type) => {
    const { workstationId, credential } = await pairWorkstation();
    await workstations.upsertPrintRoute(ctx, workstationId, type, { printerName: "POS-58", paperWidthMm: 58 });
    const start = performance.now();
    const queued = await workstations.requestTestPrint(ctx, workstationId, type);
    const requestId = queued.testPrintRequestedAt!.toISOString();
    const req = (path: string, body = {}) => new Request(`http://localhost/api/agent/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", "X-TableCore-Test-Protocol": "2" }, body: JSON.stringify(body),
    });
    const polled = await (await pollApi(req("poll"), { params: {} })).json();
    expect(polled.testPrintRequestId).toBe(requestId);
    expect(polled.testPrintRoute).toBe(type);
    expect(polled.testPrintProtocol).toBe(2);
    const claims = await Promise.all([claimApi(req("test-print/claim", { requestId }), { params: {} }), claimApi(req("test-print/claim", { requestId }), { params: {} })]);
    expect((await Promise.all(claims.map(r => r.json()))).filter(r => r.claimed)).toHaveLength(1);
    const claimMs = performance.now() - start;
    expect((await resultApi(req("test-print/result", { requestId, status: "SUCCEEDED" }), { params: {} })).status).toBe(200);
    const finished = (await workstations.listWorkstations(ctx))[0];
    expect(finished.testPrintStatus).toBe("SUCCEEDED");
    expect(finished.printRoutes.find(r => r.type === type)?.physicalTestConfirmed).toBe(false);
    console.info(JSON.stringify({ benchmark: "local-in-process-api-real-test-db-no-printer", type, requestId, claimMs, ackMs: performance.now() - start }));
  });
  it("delivers one authenticated test through heartbeat/poll, claim and ACK; legacy agents cannot bypass the claim", async () => {
    const { workstationId, credential } = await pairWorkstation();
    const queued = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const requestId = queued.testPrintRequestedAt!.toISOString();
    const request = (path: string, body = {}, protocol = "2", token = credential) => new Request(`https://example.invalid/api/agent/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-TableCore-Test-Protocol": protocol }, body: JSON.stringify(body),
    });
    const context = { params: {} };
    expect((await (await heartbeatApi(request("heartbeat", {}, "1"), context)).json()).testPrintRequested).toBe(false);
    const poll = await (await pollApi(request("poll"), context)).json();
    expect(poll.testPrintRequested).toBe(true);
    expect(poll.testPrintRequestId).toBe(requestId);
    expect((await claimApi(request("test-print/claim", { requestId }, "2", "invalid"), context)).status).toBe(401);
    expect((await (await claimApi(request("test-print/claim", { requestId }), context)).json()).claimed).toBe(true);
    expect((await (await claimApi(request("test-print/claim", { requestId }), context)).json()).claimed).toBe(false);
    expect((await resultApi(request("test-print/result", { status: "SUCCEEDED" }), context)).status).toBe(400);
    expect((await resultApi(request("test-print/result", { requestId, status: "SUCCEEDED" }), context)).status).toBe(200);
    expect((await workstations.listWorkstations(ctx))[0].testPrintStatus).toBe("SUCCEEDED");
  });
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

    await finishTest(wsCtx, "SUCCEEDED");
    const afterAck = await workstations.recordHeartbeat(wsCtx, {});
    expect(afterAck.testPrintRequested).toBe(false);
  });

  it("recordTestPrintResult(SUCCEEDED) clears any prior error and stamps completion time", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");

    await finishTest(wsCtx, "SUCCEEDED");
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } });
    expect(row.testPrintStatus).toBe("SUCCEEDED");
    expect(row.testPrintError).toBeNull();
    expect(row.testPrintCompletedAt).toBeInstanceOf(Date);
  });

  it("recordTestPrintResult(FAILED) stores the agent-reported error for Admin display", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");

    await finishTest(wsCtx, "FAILED", "Konfigurisan štampač nije dostupan.");
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

  it("repeated requests preserve the exact pending identity and do not postpone its deadline", async () => {
    const { workstationId } = await pairWorkstation();
    const [first, second] = await Promise.all([
      workstations.requestTestPrint(ctx, workstationId, "KITCHEN"),
      workstations.requestTestPrint(ctx, workstationId, "KITCHEN"),
    ]);
    expect(second.testPrintStatus).toBe("PENDING");
    expect(second.testPrintRequestedAt).toEqual(first.testPrintRequestedAt);
  });

  it("grants exactly one claim to competing agent processes, including after a lost response", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    const test = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const id = test.testPrintRequestedAt!.toISOString();
    expect((await Promise.all([workstations.claimTestPrint(wsCtx, id), workstations.claimTestPrint(wsCtx, id)])).sort()).toEqual([false, true]);
    expect(await workstations.claimTestPrint(wsCtx, id)).toBe(false);
    expect((await workstations.listWorkstations(ctx))[0].testPrintStatus).toBe("PRINTING");
    expect((await workstations.recordHeartbeat(wsCtx, {})).testPrintRequested).toBe(false);
  });

  it("rejects unsupported installed agents with an actionable upgrade error", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.recordHeartbeat(wsCtx, { agentVersion: "1.0.0-rc.2" });
    await expect(workstations.requestTestPrint(ctx, workstationId, "KITCHEN")).rejects.toThrow("v1.0.0-rc.3");
  });

  it("blocks a second route while a test is outstanding, then selects BAR independently", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await workstations.upsertPrintRoute(ctx, workstationId, "BAR", { printerName: "Bar printer", paperWidthMm: 80 });
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    await expect(workstations.requestTestPrint(ctx, workstationId, "BAR")).rejects.toThrow("druge rute");
    await finishTest(wsCtx, "SUCCEEDED");
    await workstations.requestTestPrint(ctx, workstationId, "BAR");
    expect((await workstations.recordHeartbeat(wsCtx, {})).testPrintRoute).toBe("BAR");
  });

  it("ACK replay is idempotent and a delayed ACK cannot overwrite a newer test", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    const first = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    await finishTest(wsCtx, "SUCCEEDED");
    const input = { requestId: first.testPrintRequestedAt!.toISOString(), status: "SUCCEEDED" as const };
    const before = (await workstations.listWorkstations(ctx))[0].testPrintCompletedAt;
    await workstations.recordTestPrintResult(wsCtx, input);
    expect((await workstations.listWorkstations(ctx))[0].testPrintCompletedAt).toEqual(before);
    const second = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    await workstations.recordTestPrintResult(wsCtx, input);
    const row = (await workstations.listWorkstations(ctx))[0];
    expect(row.testPrintStatus).toBe("PENDING");
    expect(row.testPrintRequestedAt).toEqual(second.testPrintRequestedAt);
  });

  it.each(["PENDING", "PRINTING"])("expires %s without automatically retrying a possibly printed ticket", async (testPrintStatus) => {
    const { workstationId, wsCtx } = await pairWorkstation();
    const old = new Date(Date.now() - 91_000);
    await prisma.workstation.update({ where: { id: workstationId }, data: { testPrintStatus, testPrintRequestedAt: old, testPrintRouteType: "KITCHEN" } });
    expect(await workstations.claimTestPrint(wsCtx, old.toISOString())).toBe(false);
    const row = (await workstations.listWorkstations(ctx))[0];
    expect(row.testPrintStatus).toBe("FAILED");
    expect(row.testPrintError).toContain("Ishod nije poznat");
    expect((await workstations.isTestPrintPending(wsCtx)).pending).toBe(false);
  });

  it("denies management without permission or location access and denies foreign claims/results", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    await expect(workstations.requestTestPrint({ ...ctx, permissions: new Set() }, workstationId, "KITCHEN")).rejects.toThrow();
    await expect(workstations.requestTestPrint({ ...ctx, locationIds: [] }, workstationId, "KITCHEN")).rejects.toThrow();
    const test = await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    const requestId = test.testPrintRequestedAt!.toISOString();
    const foreign = { ...wsCtx, restaurantId: randomUUID() };
    expect(await workstations.claimTestPrint(foreign, requestId)).toBe(false);
    await workstations.recordTestPrintResult(foreign, { requestId, status: "SUCCEEDED" });
    expect((await workstations.listWorkstations(ctx))[0].testPrintStatus).toBe("PENDING");
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
