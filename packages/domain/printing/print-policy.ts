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
