/**
 * Audit servis — JEDINO mesto u sistemu koje sme da piše u AuditLog.
 * Drugi moduli ga pozivaju posle uspešne poslovne operacije; ne pišu
 * direktno preko `prisma.auditLog.create(...)` da bi format zapisa ostao
 * dosledan (vidi requireEntry ispod).
 */

import { prisma, type Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, type AuthContext } from "@rcs/auth";

export interface AuditEntryInput {
  entityType: string;
  entityId: string;
  action: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  ipAddress?: string;
  // ── Faza 4: laka, deterministička klasifikacija — vidi napomenu na
  // AuditLog u schema.prisma. Sve opciono; pozivi bez ovih polja (Faza 1-3)
  // ostaju validni, samo dobijaju podrazumevanu ozbiljnost INFO.
  category?: string;
  severity?: "INFO" | "WARNING" | "HIGH";
  isSuspicious?: boolean;
}

export async function recordAuditEntry(
  ctx: AuthContext,
  entry: AuditEntryInput,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  await db.auditLog.create({
    data: {
      restaurantId: ctx.restaurantId,
      userId: ctx.userId,
      role: ctx.roles[0],
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      previousValue: entry.previousValue as never,
      newValue: entry.newValue as never,
      reason: entry.reason,
      ipAddress: entry.ipAddress,
      deviceId: ctx.deviceId,
      category: entry.category,
      severity: entry.severity,
      isSuspicious: entry.isSuspicious ?? false,
    },
  });
}

const AUDIT_VIEW = "audit.view";

// Prosti, fiksni pragovi (RSD/broj) — NAMERNO ne "AI"/ML skoring (zahtev
// specifikacije #14/#26). Lako se kasnije prave konfigurabilnim po
// restoranu ako se pokaže stvarna potreba — nema smisla to raditi unapred.
const FREQUENT_VOID_COUNT_THRESHOLD = 5;
const REPEATED_REASON_COUNT_THRESHOLD = 3;
const HIGH_VALUE_VOID_RSD = 3000;
const CASH_DISCREPANCY_WARNING_RSD = 500;
const CASH_DISCREPANCY_HIGH_RSD = 2000;
const UNAUTHORIZED_ATTEMPT_THRESHOLD = 3;

export interface SuspiciousSignal {
  category:
    | "FREQUENT_VOIDS"
    | "HIGH_VALUE_VOID"
    | "REPEATED_VOID_REASON"
    | "CASH_DISCREPANCY"
    | "UNAUTHORIZED_ATTEMPTS";
  severity: "INFO" | "WARNING" | "HIGH";
  employeeId: string;
  employeeName: string;
  description: string;
  occurredAt: Date;
  count?: number;
  value?: string;
}

/**
 * Vraća ČINJENICE i obrasce, NIKAD optužbe (zahtev specifikacije #15) —
 * "12 poništenih stavki u ovoj smeni", ne "ovaj konobar krade". Vlasnik
 * tumači šta to znači.
 *
 * NAMERNO odvojeno od normalnog rada konobara/kuhinje/šanka — ovo su
 * agregatni upiti nad istorijom (može biti stotine/hiljade redova), pozivaju
 * se SAMO kad vlasnik/menadžer eksplicitno otvori pregled (Faza 5 UI), nikad
 * u putanji normalne POS operacije (zahtev #25 — anti-fraud ne sme usporiti
 * POS).
 */
export async function getSuspiciousActivity(
  ctx: AuthContext,
  filters: { locationId: string; since?: Date }
): Promise<SuspiciousSignal[]> {
  requirePermission(ctx, AUDIT_VIEW);
  requireLocationAccess(ctx, filters.locationId);

  const since = filters.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const signals: SuspiciousSignal[] = [];

  const [voidsByEmployee, highValueVoids, reasonGroups, discrepancyShifts, rejectedAttempts] = await Promise.all([
    prisma.orderItemVoid.groupBy({
      by: ["voidedBy"],
      where: { restaurantId: ctx.restaurantId, locationId: filters.locationId, voidedAt: { gte: since } },
      _count: { _all: true },
      _sum: { voidedValue: true },
      _max: { voidedAt: true },
    }),
    prisma.orderItemVoid.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        locationId: filters.locationId,
        voidedAt: { gte: since },
        voidedValue: { gte: HIGH_VALUE_VOID_RSD },
      },
      orderBy: { voidedAt: "desc" },
    }),
    prisma.orderItemVoid.groupBy({
      by: ["voidedBy", "reasonCode"],
      where: { restaurantId: ctx.restaurantId, locationId: filters.locationId, voidedAt: { gte: since } },
      _count: { _all: true },
      _max: { voidedAt: true },
    }),
    prisma.shift.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        locationId: filters.locationId,
        status: "CLOSED",
        closedAt: { gte: since },
        cashDifference: { lt: -CASH_DISCREPANCY_WARNING_RSD },
      },
      orderBy: { closedAt: "desc" },
    }),
    prisma.auditLog.groupBy({
      by: ["userId"],
      where: {
        restaurantId: ctx.restaurantId,
        category: "UNAUTHORIZED_ATTEMPT",
        createdAt: { gte: since },
      },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);

  const employeeIds = new Set<string>();
  voidsByEmployee.forEach((v) => employeeIds.add(v.voidedBy));
  reasonGroups.forEach((r) => employeeIds.add(r.voidedBy));
  discrepancyShifts.forEach((s) => employeeIds.add(s.closedBy ?? s.openedBy));
  rejectedAttempts.forEach((a) => a.userId && employeeIds.add(a.userId));

  const employees = await prisma.employee.findMany({
    where: { id: { in: Array.from(employeeIds) }, restaurantId: ctx.restaurantId },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  const nameFor = (id: string) => nameById.get(id) ?? "?";

  for (const group of voidsByEmployee) {
    const count = group._count._all;
    if (count >= FREQUENT_VOID_COUNT_THRESHOLD) {
      signals.push({
        category: "FREQUENT_VOIDS",
        severity: count >= FREQUENT_VOID_COUNT_THRESHOLD * 2 ? "HIGH" : "WARNING",
        employeeId: group.voidedBy,
        employeeName: nameFor(group.voidedBy),
        description: `${count} poništenih stavki u posmatranom periodu (ukupna vrednost ${group._sum.voidedValue?.toString() ?? "0"} RSD)`,
        occurredAt: group._max.voidedAt ?? since,
        count,
        value: group._sum.voidedValue?.toString(),
      });
    }
  }

  for (const voidRow of highValueVoids) {
    signals.push({
      category: "HIGH_VALUE_VOID",
      severity: "HIGH",
      employeeId: voidRow.voidedBy,
      employeeName: nameFor(voidRow.voidedBy),
      description: `Poništena stavka visoke vrednosti: ${voidRow.itemName} × ${voidRow.voidedQuantity} (${voidRow.voidedValue.toString()} RSD) — razlog: ${voidRow.reasonCode}`,
      occurredAt: voidRow.voidedAt,
      value: voidRow.voidedValue.toString(),
    });
  }

  for (const group of reasonGroups) {
    const count = group._count._all;
    if (count >= REPEATED_REASON_COUNT_THRESHOLD) {
      signals.push({
        category: "REPEATED_VOID_REASON",
        severity: "INFO",
        employeeId: group.voidedBy,
        employeeName: nameFor(group.voidedBy),
        description: `Isti razlog poništavanja (${group.reasonCode}) naveden ${count} puta`,
        occurredAt: group._max.voidedAt ?? since,
        count,
      });
    }
  }

  for (const shift of discrepancyShifts) {
    const difference = shift.cashDifference ? Number(shift.cashDifference) : 0;
    const employeeId = shift.closedBy ?? shift.openedBy;
    signals.push({
      category: "CASH_DISCREPANCY",
      severity: Math.abs(difference) >= CASH_DISCREPANCY_HIGH_RSD ? "HIGH" : "WARNING",
      employeeId,
      employeeName: nameFor(employeeId),
      description: `Razlika u gotovini pri zatvaranju smene: ${difference.toFixed(2)} RSD (očekivano ${shift.expectedCash?.toString()}, prijavljeno ${shift.countedCash?.toString()})`,
      occurredAt: shift.closedAt ?? since,
      value: shift.cashDifference?.toString(),
    });
  }

  for (const group of rejectedAttempts) {
    const count = group._count._all;
    if (group.userId && count >= UNAUTHORIZED_ATTEMPT_THRESHOLD) {
      const employee = await prisma.employee.findFirst({ where: { userId: group.userId, restaurantId: ctx.restaurantId }, select: { id: true, firstName: true, lastName: true } });
      signals.push({
        category: "UNAUTHORIZED_ATTEMPTS",
        severity: count >= UNAUTHORIZED_ATTEMPT_THRESHOLD * 2 ? "HIGH" : "WARNING",
        employeeId: employee?.id ?? group.userId,
        employeeName: employee ? `${employee.firstName} ${employee.lastName}` : "?",
        description: `${count} odbijenih pokušaja neovlašćene operacije u posmatranom periodu`,
        occurredAt: group._max.createdAt ?? since,
        count,
      });
    }
  }

  return signals.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}
