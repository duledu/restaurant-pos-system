/**
 * P2.2 — Lightweight Anti-Fraud Dashboard.
 *
 * NAMERNO ne novi "anomaly engine": ovaj fajl SAMO (a) ponovo koristi
 * postojeći getSuspiciousActivity (audit-service.ts) kao jedinstveni izvor
 * signala i (b) dodaje detaljne liste/agregacije za dashboard prikaz —
 * ponovnom upotrebom reporting-service.ts funkcija (getEmployeeActivity,
 * getShiftReport, resolveContext) gde god je to moguće, umesto duplog
 * računanja istih brojeva.
 *
 * FILOZOFIJA (specifikacija #2): sve ovde su ČINJENICE i obrasci —
 * "za proveru", "neuobičajena aktivnost" — NIKAD optužba ("krađa", "lopov").
 * Dashboard je READ-ONLY: nema auto-fix/auto-delete/auto-void ovde.
 *
 * PERMISIJA: "audit.view" (isto kao Reports 2.0 i getSuspiciousActivity) —
 * namerno bez nove permisije (isti razlog kao u reporting-service.ts).
 */

import { prisma, Prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { resolveContext, getEmployeeActivity, type ReportFilters } from "../reporting/reporting-service";
import { getSuspiciousActivity, resolveEmployeeDisplayNames, type SuspiciousSignal } from "./audit-service";
import { VOID_REASON_LABELS, type VoidReasonCode } from "@rcs/shared";

// Ista granica kao Reports 2.0 (reporting-service.ts LIST_ROW_CAP) — anti-fraud
// je operativni pregled, ne istorijski izvoz (specifikacija #26).
const LIST_ROW_CAP = 200;

function decimalToNumber(value: Prisma.Decimal | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** Bezbedna stopa — nikad NaN/Infinity (specifikacija #22/#23). */
function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

// ── SIGNALI (event feed) — tanka obertka oko getSuspiciousActivity ─────────

export async function getSignals(ctx: AuthContext, filters: ReportFilters): Promise<SuspiciousSignal[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);
  return getSuspiciousActivity(ctx, {
    locationId: locationIds.length === 1 ? locationIds[0] : "ALL",
    since: range.from,
    until: range.to,
  });
}

// ── STORNA (detaljno, sa proizvodnim kontekstom i brojem računa) ───────────

export interface VoidEventRow {
  id: string;
  employeeId: string;
  employeeName: string;
  role: string;
  tableLabel: string;
  itemName: string;
  voidedQuantity: number;
  unitPrice: string;
  voidedValue: string;
  reasonCode: VoidReasonCode;
  reasonLabel: string;
  explanation: string;
  voidedAt: string;
  orderId: string;
  /** Ljudski čitljiv broj računa (Receipt.sequenceNumber) — postoji SAMO ako
   * je porudžbina u međuvremenu naplaćena (za neke stavke ta porudžbina
   * možda nikad ne bude naplaćena — receiptNumber ostaje null, ne izmišljamo
   * broj). Prikazuje se umesto "sirovog" orderId (specifikacija #18). */
  receiptNumber: number | null;
  isFullVoid: boolean;
  /** true SAMO za potpun storno gde je stavka VEĆ bila servirana (SERVED) u
   * trenutku storna — vidi napomenu u audit-service.ts getSuspiciousActivity
   * (VOID_AFTER_PRODUCTION) za zašto se ovo ne proverava za delimičan storno. */
  producedBeforeVoid: boolean;
}

export async function getVoidEvents(ctx: AuthContext, filters: ReportFilters): Promise<VoidEventRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const rows = await prisma.orderItemVoid.findMany({
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
    orderBy: { voidedAt: "desc" },
    take: LIST_ROW_CAP,
  });
  if (rows.length === 0) return [];

  const orderItemIds = rows.map((r) => r.orderItemId);
  const orderIds = Array.from(new Set(rows.map((r) => r.orderId)));

  const [nameById, servedStations, receipts] = await Promise.all([
    resolveEmployeeDisplayNames(ctx.restaurantId, rows.map((r) => r.voidedBy)),
    prisma.orderItemStation.findMany({
      where: { orderItemId: { in: orderItemIds }, status: "SERVED" },
      select: { orderItemId: true },
    }),
    prisma.receipt.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, sequenceNumber: true },
    }),
  ]);
  const servedItemIds = new Set(servedStations.map((s) => s.orderItemId));
  const receiptByOrderId = new Map(receipts.map((r) => [r.orderId, r.sequenceNumber]));

  return rows.map((r) => {
    const isFullVoid = r.quantityAfter === 0;
    return {
      id: r.id,
      employeeId: r.voidedBy,
      employeeName: nameById.get(r.voidedBy)?.name ?? "?",
      role: nameById.get(r.voidedBy)?.role ?? r.voidedByRole,
      tableLabel: r.tableLabel,
      itemName: r.itemName,
      voidedQuantity: r.voidedQuantity,
      unitPrice: r.unitPrice.toString(),
      voidedValue: r.voidedValue.toString(),
      reasonCode: r.reasonCode as VoidReasonCode,
      reasonLabel: VOID_REASON_LABELS[r.reasonCode as VoidReasonCode] ?? r.reasonCode,
      explanation: r.explanation,
      voidedAt: r.voidedAt.toISOString(),
      orderId: r.orderId,
      receiptNumber: receiptByOrderId.get(r.orderId) ?? null,
      isFullVoid,
      producedBeforeVoid: isFullVoid && servedItemIds.has(r.orderItemId),
    };
  });
}

// ── GOTOVINA (razlike pri zatvaranju smene) ────────────────────────────────

export interface CashDiscrepancyEventRow {
  shiftId: string;
  locationId: string;
  closedByName: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  cashDifference: string;
  kind: "shortage" | "overage";
}

export async function getCashDiscrepancyEvents(ctx: AuthContext, filters: ReportFilters): Promise<CashDiscrepancyEventRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  // NAMERNO direktan upit (ne ponovna upotreba getShiftReport) — getShiftReport
  // filtrira po openedAt (za "šta je otvoreno u periodu"), dok se razlika u
  // gotovini utvrđuje pri ZATVARANJU. Filtriranje po closedAt ovde drži ovaj
  // event feed dosledan getSuspiciousActivity's CASH_DISCREPANCY signalu
  // (isti filter), umesto da smena koja premošćava ponoć bude prikazana u
  // jednom a izostavljena iz drugog.
  const shifts = await prisma.shift.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      locationId: { in: locationIds },
      status: "CLOSED",
      closedAt: { gte: range.from, lt: range.to },
      cashDifference: { not: 0 },
    },
    orderBy: { closedAt: "desc" },
    take: LIST_ROW_CAP,
  });
  if (shifts.length === 0) return [];

  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, shifts.map((s) => s.closedBy));

  return shifts
    .map((s) => ({
      shiftId: s.id,
      locationId: s.locationId,
      closedByName: s.closedBy ? (nameById.get(s.closedBy)?.name ?? "?") : null,
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      openingCash: s.openingCash.toString(),
      expectedCash: s.expectedCash?.toString() ?? null,
      countedCash: s.countedCash?.toString() ?? null,
      cashDifference: s.cashDifference!.toString(),
      kind: Number(s.cashDifference) < 0 ? ("shortage" as const) : ("overage" as const),
    }))
    .sort((a, b) => Math.abs(Number(b.cashDifference)) - Math.abs(Number(a.cashDifference)));
}

// ── ZALIHE (ručne korekcije / otpisi) ──────────────────────────────────────

export interface InventoryAdjustmentEventRow {
  id: string;
  itemName: string;
  employeeId: string | null;
  employeeName: string;
  type: "ADJUSTMENT" | "WRITE_OFF";
  quantityDelta: string;
  quantityBefore: string;
  quantityAfter: string;
  reason: string | null;
  createdAt: string;
}

export async function getInventoryAdjustmentEvents(ctx: AuthContext, filters: ReportFilters): Promise<InventoryAdjustmentEventRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const rows = await prisma.inventoryMovement.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      locationId: { in: locationIds },
      type: { in: ["ADJUSTMENT", "WRITE_OFF"] },
      createdAt: { gte: range.from, lt: range.to },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_ROW_CAP,
  });
  if (rows.length === 0) return [];

  const [menuItems, nameById] = await Promise.all([
    prisma.menuItem.findMany({ where: { id: { in: rows.map((r) => r.menuItemId) } }, select: { id: true, name: true } }),
    resolveEmployeeDisplayNames(ctx.restaurantId, rows.map((r) => r.employeeId)),
  ]);
  const itemNameById = new Map(menuItems.map((m) => [m.id, m.name]));

  return rows.map((r) => ({
    id: r.id,
    itemName: itemNameById.get(r.menuItemId) ?? "?",
    employeeId: r.employeeId,
    employeeName: r.employeeId ? (nameById.get(r.employeeId)?.name ?? "?") : "—",
    type: r.type as "ADJUSTMENT" | "WRITE_OFF",
    quantityDelta: r.quantityDelta.toString(),
    quantityBefore: r.quantityBefore.toString(),
    quantityAfter: r.quantityAfter.toString(),
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── ZAPOSLENI (rezime, ne kaznena rang-lista) ──────────────────────────────

export interface EmployeeAntiFraudRow {
  employeeId: string;
  employeeName: string;
  role: string;
  paidSales: string;
  paidChecks: number;
  voidCount: number;
  voidValue: string;
  /** voidCount / paidChecks — null ako zaposleni nema nijedan naplaćen ček
   * u periodu (nema smislenog imenioca, specifikacija #22/#23). */
  voidRateByChecks: number | null;
  /** voidValue / paidSales — isti razlog za null kao gore. */
  voidRateByValue: number | null;
  shiftsClosedCount: number;
  /** Neto razlika u gotovini preko SVIH smena koje je zaposleni zatvorio u
   * periodu (zbir, ne apsolutna vrednost) — isto polje kao postojeći
   * reporting.getEmployeeActivity, ponovo iskorišćeno, ne preračunato. */
  netCashDifference: string | null;
  inventoryAdjustments: number;
  inventoryWriteOffs: number;
  /** Broj signala iz getSuspiciousActivity vezanih za ovog zaposlenog u
   * periodu — VIDLJIV I OBJAŠNJIV brojač (svaki signal je već sam po sebi
   * objašnjen pravilom/pragom), NIKAD skriven "fraud score" (specifikacija #9/#10). */
  signalsCount: number;
}

export async function getEmployeeAntiFraudSummary(ctx: AuthContext, filters: ReportFilters): Promise<EmployeeAntiFraudRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const [activity, inventoryGroups, signals] = await Promise.all([
    // Ponovna upotreba Reports 2.0 agregacije (prodaja/void/smene po
    // zaposlenom) — ne dupliramo Payment/Void/Shift upite.
    getEmployeeActivity(ctx, filters),
    prisma.inventoryMovement.groupBy({
      by: ["employeeId", "type"],
      where: {
        restaurantId: ctx.restaurantId,
        locationId: { in: locationIds },
        type: { in: ["ADJUSTMENT", "WRITE_OFF"] },
        createdAt: { gte: range.from, lt: range.to },
        employeeId: { not: null },
      },
      _count: { _all: true },
    }),
    getSuspiciousActivity(ctx, {
      locationId: locationIds.length === 1 ? locationIds[0] : "ALL",
      since: range.from,
      until: range.to,
    }),
  ]);

  const adjustmentsByEmployee = new Map<string, { adjustments: number; writeOffs: number }>();
  for (const g of inventoryGroups) {
    if (!g.employeeId) continue;
    const bucket = adjustmentsByEmployee.get(g.employeeId) ?? { adjustments: 0, writeOffs: 0 };
    if (g.type === "ADJUSTMENT") bucket.adjustments += g._count._all;
    else bucket.writeOffs += g._count._all;
    adjustmentsByEmployee.set(g.employeeId, bucket);
  }

  const signalsByEmployee = new Map<string, number>();
  for (const s of signals) {
    if (!s.employeeId) continue; // npr. REPEATED_ITEM_WRITE_OFF je vezan za artikal, ne zaposlenog
    signalsByEmployee.set(s.employeeId, (signalsByEmployee.get(s.employeeId) ?? 0) + 1);
  }

  return activity.map((row) => {
    const inv = adjustmentsByEmployee.get(row.employeeId) ?? { adjustments: 0, writeOffs: 0 };
    return {
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      role: row.role,
      paidSales: row.sales,
      paidChecks: row.completedOrders,
      voidCount: row.voidCount,
      voidValue: row.voidValue,
      voidRateByChecks: safeRate(row.voidCount, row.completedOrders),
      voidRateByValue: safeRate(decimalToNumber(row.voidValue), decimalToNumber(row.sales)),
      shiftsClosedCount: row.shiftsClosedCount,
      netCashDifference: row.cashDifference,
      inventoryAdjustments: inv.adjustments,
      inventoryWriteOffs: inv.writeOffs,
      signalsCount: signalsByEmployee.get(row.employeeId) ?? 0,
    };
  });
}

// ── PREGLED (kartice za summary) ───────────────────────────────────────────

export interface AntiFraudOverview {
  signalsCount: number;
  voidCount: number;
  voidValue: string;
  cashDiscrepancyAbsTotal: string;
  cashDiscrepancyShiftsCount: number;
  inventoryCorrectionsCount: number;
}

export async function getAntiFraudOverview(ctx: AuthContext, filters: ReportFilters): Promise<AntiFraudOverview> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const [signals, voidAgg, cashEvents, inventoryCount] = await Promise.all([
    getSuspiciousActivity(ctx, {
      locationId: locationIds.length === 1 ? locationIds[0] : "ALL",
      since: range.from,
      until: range.to,
    }),
    prisma.orderItemVoid.aggregate({
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
      _sum: { voidedValue: true },
    }),
    getCashDiscrepancyEvents(ctx, filters),
    prisma.inventoryMovement.count({
      where: {
        restaurantId: ctx.restaurantId,
        locationId: { in: locationIds },
        type: { in: ["ADJUSTMENT", "WRITE_OFF"] },
        createdAt: { gte: range.from, lt: range.to },
      },
    }),
  ]);

  const cashAbsTotal = cashEvents.reduce((sum, e) => sum + Math.abs(Number(e.cashDifference)), 0);

  return {
    signalsCount: signals.length,
    voidCount: voidAgg._count._all,
    voidValue: decimalToNumber(voidAgg._sum.voidedValue).toFixed(2),
    cashDiscrepancyAbsTotal: cashAbsTotal.toFixed(2),
    cashDiscrepancyShiftsCount: cashEvents.length,
    inventoryCorrectionsCount: inventoryCount,
  };
}
