import { Prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";

/** One lock order everywhere: tenant-owned location, then config/job rows. */
export async function lockPrintLocation(tx: Prisma.TransactionClient, restaurantId: string, locationId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM locations WHERE id = ${locationId} AND "restaurantId" = ${restaurantId} FOR UPDATE
  `);
  if (!rows.length) throw new ForbiddenError("Lokacija nije dostupna");
}

export async function stationPolicy(tx: Prisma.TransactionClient, restaurantId: string, locationId: string, station: "KITCHEN" | "BAR" | "RECEIPT") {
  const row = await tx.printerConfig.findUnique({ where: { locationId_station: { locationId, station } } });
  if (row && row.restaurantId !== restaurantId) throw new ForbiddenError("Printer configuration tenant mismatch");
  // Preserve the existing no-configuration default. An explicit config is authoritative.
  return { paperWidthMm: row?.paperWidthMm ?? 80, isEnabled: row?.isEnabled ?? true,
    autoPrint: row?.autoPrint ?? true, automaticSince: row?.automaticSince ?? null };
}

export async function suppressAutomaticJobs(tx: Prisma.TransactionClient, restaurantId: string, locationId: string, station: "KITCHEN" | "BAR" | "RECEIPT") {
  if (station === "RECEIPT") return { count: 0 };
  return tx.printJob.updateMany({
    where: { restaurantId, locationId, station, isAutomatic: true,
      OR: [{ status: "PENDING" }, { status: "PRINTING", submissionStartedAt: null }] },
    data: { status: "SUPPRESSED", failureReason: "Automatska štampa isključena; potreban je izričit novi otisak." },
  });
}

// Faza 2C follow-up — dokazan latentan rizik: dispatchStationPrintJobs i
// listPendingStationPrintJobs su čitali ISKLJUČIVO legacy PrinterConfig
// (Browser/QZ) da odluče da li je automatska štampa dozvoljena za stanicu,
// čak i kad je TableCore Print Agent (Workstation) za tu tačnu stanicu
// upravo spreman i heartbeat-uje. To znači da je legacy "Automatska štampa
// novih porudžbina" checkbox (isEnabled=false/autoPrint=false na
// PrinterConfig redu) mogao TIHO da blokira normalan server-side
// automatski PrintJob za Agenta, iako Agent nema NIKAKVU zavisnost od tog
// reda (Agent poll/claim, agent-print-service.ts pollAndClaim, ga uopšte
// ne čita). Print Agent spremnost MORA biti autoritativan izvor za
// NORMALAN (automatski) put; legacy/QZ podešavanje ostaje relevantno
// SAMO kad Agent NIJE aktivan za tu stanicu (ručni/rezervni put).
//
// Isti prag (2 min) i uslovi kao agent-print-service.ts's
// isAgentActiveForStation — namerno JEDNO mesto za "da li je Agent
// spreman za ovu stanicu", da dispatch (ovde) i status-prikaz
// (agent-print-service.ts) nikad ne mogu tiho da se razminu.
export const AGENT_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export type PrintRouteTypeValue = "KITCHEN" | "BAR" | "RECEIPT";

/**
 * PRINTING V2 FINAL — the SINGLE, mode-aware source of truth for "which one
 * physical workstation is eligible to serve this restaurant/location/type
 * right now", shared by dispatch gating (activeWorkstationFor below),
 * claim eligibility (agent-print-service.ts activeRouteTypes), and Admin/KDS
 * status. Never "whichever Agent polls first" — always deterministic:
 *
 * - CENTRAL_ROUTING: any enabled route of this type on an online, non-revoked
 *   workstation is a candidate. If more than one exists (multiple Agents
 *   configured for the same type), an explicit `isPrimary` route always wins;
 *   otherwise the LOWEST workstationId wins — arbitrary but 100% stable and
 *   reproducible (never depends on heartbeat timing/poll order). With today's
 *   single-workstation-per-location physical reality this is a no-op (exactly
 *   one candidate), so no existing restaurant's behavior changes.
 * - LOGIN_AWARE: browser login, not route configuration, decides eligibility.
 *   Only a workstation whose CURRENT WorkstationTerminalSession.printRole
 *   matches `type` (and has that route configured+enabled) is a candidate —
 *   see workstation-service.ts's terminal-binding flow for how that session
 *   is established. Never login-role, never Agent-asserted.
 */
export async function resolveEligibleWorkstation(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  locationId: string,
  type: PrintRouteTypeValue
): Promise<{ workstationId: string; paperWidthMm: number | null } | null> {
  const restaurant = await tx.restaurant.findUnique({ where: { id: restaurantId }, select: { printingMode: true } });
  const onlineWorkstation = {
    isEnabled: true,
    revokedAt: null,
    lastSeenAt: { gt: new Date(Date.now() - AGENT_ACTIVE_WINDOW_MS) },
  };

  if (restaurant?.printingMode === "LOGIN_AWARE") {
    const route = await tx.workstationPrintRoute.findFirst({
      where: {
        restaurantId, locationId, type, isEnabled: true,
        workstation: { ...onlineWorkstation, terminalSession: { printRole: type, expiresAt: { gt: new Date() } } },
      },
      select: { workstationId: true, paperWidthMm: true },
    });
    return route;
  }

  // CENTRAL_ROUTING — deterministic multi-agent tie-break (see doc comment).
  const candidates = await tx.workstationPrintRoute.findMany({
    where: { restaurantId, locationId, type, isEnabled: true, workstation: onlineWorkstation },
    select: { workstationId: true, paperWidthMm: true, isPrimary: true },
  });
  if (candidates.length === 0) return null;
  const primary = candidates.find((c) => c.isPrimary);
  if (primary) return primary;
  return [...candidates].sort((a, b) => a.workstationId.localeCompare(b.workstationId))[0];
}

// Printing V2 — widened from the old "KITCHEN"|"BAR" (a single Workstation
// locked to one station) to the full PrintJobType so RECEIPT can finally be
// agent-routed too: eligibility now comes from an enabled WorkstationPrintRoute
// row of this exact type, joined to its parent workstation, rather than a
// scalar Workstation.station column. A workstation can have several routes
// (KITCHEN/BAR/RECEIPT), each independently active. Kept as a thin wrapper
// (existing callers only ever destructure `.paperWidthMm`) over the new
// mode-aware resolveEligibleWorkstation above — one shared decision, never a
// second slightly-different one.
export async function activeWorkstationFor(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  locationId: string,
  type: PrintRouteTypeValue
): Promise<{ paperWidthMm: number | null } | null> {
  const resolved = await resolveEligibleWorkstation(tx, restaurantId, locationId, type);
  return resolved ? { paperWidthMm: resolved.paperWidthMm } : null;
}
