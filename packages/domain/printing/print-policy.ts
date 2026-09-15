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

export async function activeWorkstationFor(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  locationId: string,
  station: "KITCHEN" | "BAR"
): Promise<{ paperWidthMm: number | null } | null> {
  // Hardening audit finding: if an admin mistakenly pairs two workstations
  // to the same station (both live), findFirst without an explicit order
  // depends on undefined DB row order — deterministically prefer the MOST
  // RECENTLY active one (same convention as stationPrinterStatus below),
  // so which one's paperWidthMm gets snapshotted into ticket content is at
  // least predictable rather than arbitrary. This does not change which
  // physical workstation actually wins the print CLAIM (that stays a fair,
  // atomic race via beginPrintAttempt's updateMany) — only which one's
  // reported paper width is used to size the ticket that gets created.
  return tx.workstation.findFirst({
    where: {
      restaurantId,
      locationId,
      station,
      isEnabled: true,
      revokedAt: null,
      lastSeenAt: { gt: new Date(Date.now() - AGENT_ACTIVE_WINDOW_MS) },
    },
    orderBy: { lastSeenAt: "desc" },
    select: { paperWidthMm: true },
  });
}
