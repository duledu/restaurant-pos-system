/**
 * Faza 5 — servisni sloj za vlasnički/menadžerski pregled poslovanja.
 *
 * IZVOR ISTINE: finansijski brojevi dolaze iz Payment (i njegovog Receipt
 * snapshot-a), NIKAD iz preračunavanja OrderItem/MenuItem u trenutku upita
 * — vidi napomenu u date-range.ts (#26 specifikacije). Kasnija izmena cene
 * artikla ili naziva restorana ne sme promeniti istorijski izveštaj.
 *
 * PERMISIJA: sve funkcije ovde zahtevaju "audit.view" (isto kao Faza 4
 * getSuspiciousActivity) — namerno NIJE uvedena nova "reports.view"
 *
 * agregacija prodatih artikala je izvučena kao čista funkcija
 * `aggregateSoldItems` kako bi mogla biti unit-testirana bez baze.
 * permisija, jer bi trenutno pokrivala IDENTIČAN skup rola
 * (OWNER/ADMIN/MANAGER); nova permisija bez stvarne razlike u dodeli je
 * prerana apstrakcija (isti princip kao i drugde u projektu). Ako se
 * kasnije pokaže potreba da neko ima uvid u izveštaje bez uvida u
 * audit/sumnjivu aktivnost, razdvoji ih tada.
 *
 * PERFORMANSE: sve agregacije idu kroz Prisma groupBy/count (SQL agregacija
 * na bazi), nikad "učitaj sve pa saberi u Node-u" — vidi #19 specifikacije.
 */

import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, type AuthContext } from "@rcs/auth";
import { resolveDateRange, type ReportPreset } from "./date-range";
import { resolveEmployeeDisplayNames } from "../audit/audit-service";
import { VOID_REASON_LABELS, type VoidReasonCode } from "@rcs/shared";

const REPORTING_PERMISSION = "audit.view";

// Gornja granica za detaljne liste (void-i, activity log) — ovo je pregled
// za vlasnika, ne export/analitički alat. Sprečava da se slučajno povuče
// ogroman broj redova u UI odgovor (#19).
const LIST_ROW_CAP = 200;

export interface ReportFilters {
  locationId: string; // "ALL" ili konkretan ID
  preset: ReportPreset;
  from?: string;
  to?: string;
}

async function resolveContext(ctx: AuthContext, filters: ReportFilters) {
  requirePermission(ctx, REPORTING_PERMISSION);

  let locationIds: string[];
  if (filters.locationId === "ALL") {
    locationIds = ctx.locationIds;
  } else {
    requireLocationAccess(ctx, filters.locationId);
    locationIds = [filters.locationId];
  }
  if (locationIds.length === 0) {
    throw new Error("Nalog nema dodeljenu nijednu lokaciju");
  }

  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: ctx.restaurantId },
    select: { timezone: true, currency: true },
  });
  const range = resolveDateRange(filters.preset, restaurant.timezone, { customFrom: filters.from, customTo: filters.to });

  return { locationIds, range, currency: restaurant.currency, timezone: restaurant.timezone };
}

function decimalToString(value: Prisma.Decimal | null | undefined): string {
  return (value ?? new Prisma.Decimal(0)).toString();
}

export interface LocationOption {
  id: string;
  name: string;
}

/** Za padajuću listu lokacija u filteru izveštaja — server vraća SAMO
 * lokacije na koje zaposleni stvarno ima pristup, nikad ceo restoran. */
export async function listAccessibleLocations(ctx: AuthContext): Promise<LocationOption[]> {
  requirePermission(ctx, REPORTING_PERMISSION);
  if (ctx.locationIds.length === 0) return [];
  return prisma.location.findMany({
    where: { restaurantId: ctx.restaurantId, id: { in: ctx.locationIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

// ── PRODAJA ─────────────────────────────────────────────────────────────

export interface SalesSummary {
  range: { from: string; to: string };
  currency: string;
  totalSales: string;
  cashSales: string;
  cardSales: string;
  completedOrders: number;
  averageOrderValue: string;
  cashPercent: number;
  cardPercent: number;
}

export async function getSalesSummary(ctx: AuthContext, filters: ReportFilters): Promise<SalesSummary> {
  const { locationIds, range, currency } = await resolveContext(ctx, filters);

  const grouped = await prisma.payment.groupBy({
    by: ["method"],
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, completedAt: { gte: range.from, lt: range.to } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  let cashSales = new Prisma.Decimal(0);
  let cardSales = new Prisma.Decimal(0);
  let completedOrders = 0;
  for (const g of grouped) {
    completedOrders += g._count._all;
    if (g.method === "CASH") cashSales = cashSales.add(g._sum.amount ?? 0);
    else cardSales = cardSales.add(g._sum.amount ?? 0);
  }
  const totalSales = cashSales.add(cardSales);
  const averageOrderValue = completedOrders > 0 ? totalSales.div(completedOrders).toDecimalPlaces(2) : new Prisma.Decimal(0);
  const cashPercent = totalSales.isZero() ? 0 : cashSales.div(totalSales).mul(100).toDecimalPlaces(1).toNumber();
  const cardPercent = totalSales.isZero() ? 0 : cardSales.div(totalSales).mul(100).toDecimalPlaces(1).toNumber();

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    currency,
    totalSales: totalSales.toString(),
    cashSales: cashSales.toString(),
    cardSales: cardSales.toString(),
    completedOrders,
    averageOrderValue: averageOrderValue.toString(),
    cashPercent,
    cardPercent,
  };
}

export interface EmployeeSales {
  employeeId: string;
  employeeName: string;
  role: string;
  orders: number;
  sales: string;
}

export async function getSalesByEmployee(ctx: AuthContext, filters: ReportFilters): Promise<EmployeeSales[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const grouped = await prisma.payment.groupBy({
    by: ["completedBy"],
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, completedAt: { gte: range.from, lt: range.to } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, grouped.map((g) => g.completedBy));

  return grouped
    .map((g) => ({
      employeeId: g.completedBy,
      employeeName: nameById.get(g.completedBy)?.name ?? "?",
      role: nameById.get(g.completedBy)?.role ?? "?",
      orders: g._count._all,
      sales: decimalToString(g._sum.amount),
    }))
    .sort((a, b) => Number(b.sales) - Number(a.sales));
}

// ── TRENUTNO STANJE RESTORANA ───────────────────────────────────────────

export interface CurrentStatus {
  openTables: number;
  activeOrders: number;
  openShiftsCount: number;
  shiftsOnDuty: {
    shiftId: string;
    locationId: string;
    employeeName: string;
    role: string;
    openedAt: string;
  }[];
}

/**
 * "Trenutno na dužnosti" = ko je OTVORIO svaku otvorenu smenu — Faza 1-4 ne
 * uvodi pravo evidentiranje prijave/odjave PO ZAPOSLENOM (samo ko je
 * otvorio/zatvorio smenu za lokaciju), pa je ovo najpoštenije što se može
 * tvrditi iz postojećih podataka bez izmišljanja prisustva. Videti Fazu 5
 * izveštaj — puna "ko je trenutno u smeni" evidencija bi zahtevala novi
 * clock-in/out model, van obima ove faze.
 */
export async function getCurrentStatus(ctx: AuthContext, filters: { locationId: string }): Promise<CurrentStatus> {
  requirePermission(ctx, REPORTING_PERMISSION);
  let locationIds: string[];
  if (filters.locationId === "ALL") {
    locationIds = ctx.locationIds;
  } else {
    requireLocationAccess(ctx, filters.locationId);
    locationIds = [filters.locationId];
  }
  if (locationIds.length === 0) throw new Error("Nalog nema dodeljenu nijednu lokaciju");

  const [openTables, activeOrders, openShifts] = await Promise.all([
    prisma.restaurantTable.count({
      where: { status: { in: ["OCCUPIED", "AWAITING_BILL"] }, floor: { restaurantId: ctx.restaurantId, locationId: { in: locationIds } } },
    }),
    prisma.order.count({
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    }),
    prisma.shift.findMany({
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, status: "OPEN" },
      orderBy: { openedAt: "asc" },
    }),
  ]);

  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, openShifts.map((s) => s.openedBy));

  return {
    openTables,
    activeOrders,
    openShiftsCount: openShifts.length,
    shiftsOnDuty: openShifts.map((s) => ({
      shiftId: s.id,
      locationId: s.locationId,
      employeeName: nameById.get(s.openedBy)?.name ?? "?",
      role: nameById.get(s.openedBy)?.role ?? "?",
      openedAt: s.openedAt.toISOString(),
    })),
  };
}

// ── SMENE ───────────────────────────────────────────────────────────────

export interface ShiftReportRow {
  id: string;
  status: "OPEN" | "CLOSED";
  employeeName: string;
  role: string;
  openedAt: string;
  closedAt: string | null;
  closedByName: string | null;
  cashSales: string;
  cardSales: string;
  totalSales: string;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  cashDifference: string | null;
}

export async function getShiftReport(ctx: AuthContext, filters: ReportFilters): Promise<ShiftReportRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const shifts = await prisma.shift.findMany({
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, openedAt: { gte: range.from, lt: range.to } },
    orderBy: { openedAt: "desc" },
    take: LIST_ROW_CAP,
  });
  if (shifts.length === 0) return [];

  const shiftIds = shifts.map((s) => s.id);
  const paymentGroups = await prisma.payment.groupBy({
    by: ["shiftId", "method"],
    where: { shiftId: { in: shiftIds } },
    _sum: { amount: true },
  });
  const salesByShift = new Map<string, { cash: Prisma.Decimal; card: Prisma.Decimal }>();
  for (const g of paymentGroups) {
    const bucket = salesByShift.get(g.shiftId) ?? { cash: new Prisma.Decimal(0), card: new Prisma.Decimal(0) };
    if (g.method === "CASH") bucket.cash = bucket.cash.add(g._sum.amount ?? 0);
    else bucket.card = bucket.card.add(g._sum.amount ?? 0);
    salesByShift.set(g.shiftId, bucket);
  }

  const employeeIds = shifts.flatMap((s) => [s.openedBy, s.closedBy]);
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, employeeIds);

  return shifts.map((s) => {
    const sales = salesByShift.get(s.id) ?? { cash: new Prisma.Decimal(0), card: new Prisma.Decimal(0) };
    return {
      id: s.id,
      status: s.status,
      employeeName: nameById.get(s.openedBy)?.name ?? "?",
      role: nameById.get(s.openedBy)?.role ?? "?",
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      closedByName: s.closedBy ? (nameById.get(s.closedBy)?.name ?? "?") : null,
      cashSales: sales.cash.toString(),
      cardSales: sales.card.toString(),
      totalSales: sales.cash.add(sales.card).toString(),
      openingCash: s.openingCash.toString(),
      expectedCash: s.expectedCash?.toString() ?? null,
      countedCash: s.countedCash?.toString() ?? null,
      cashDifference: s.cashDifference?.toString() ?? null,
    };
  });
}

// ── PONIŠTAVANJA (VOID) ─────────────────────────────────────────────────

export interface VoidReportRow {
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
}

export async function getVoidReport(ctx: AuthContext, filters: ReportFilters): Promise<VoidReportRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const rows = await prisma.orderItemVoid.findMany({
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
    orderBy: { voidedAt: "desc" },
    take: LIST_ROW_CAP,
  });
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, rows.map((r) => r.voidedBy));

  return rows.map((r) => ({
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
  }));
}

export interface VoidSummaryRow {
  employeeId: string;
  employeeName: string;
  role: string;
  voidCount: number;
  voidValue: string;
}

export async function getVoidSummaryByEmployee(ctx: AuthContext, filters: ReportFilters): Promise<VoidSummaryRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const grouped = await prisma.orderItemVoid.groupBy({
    by: ["voidedBy"],
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
    _count: { _all: true },
    _sum: { voidedValue: true },
  });
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, grouped.map((g) => g.voidedBy));

  return grouped
    .map((g) => ({
      employeeId: g.voidedBy,
      employeeName: nameById.get(g.voidedBy)?.name ?? "?",
      role: nameById.get(g.voidedBy)?.role ?? "?",
      voidCount: g._count._all,
      voidValue: decimalToString(g._sum.voidedValue),
    }))
    .sort((a, b) => Number(b.voidValue) - Number(a.voidValue));
}

// ── AKTIVNOST PO ZAPOSLENOM ─────────────────────────────────────────────

export interface EmployeeActivityRow {
  employeeId: string;
  employeeName: string;
  role: string;
  completedOrders: number;
  sales: string;
  cashHandled: string;
  cardHandled: string;
  voidCount: number;
  voidValue: string;
  shiftsClosedCount: number;
  cashDifference: string | null;
}

export async function getEmployeeActivity(ctx: AuthContext, filters: ReportFilters): Promise<EmployeeActivityRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);

  const [salesGroups, voidGroups, closedShifts] = await Promise.all([
    prisma.payment.groupBy({
      by: ["completedBy", "method"],
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, completedAt: { gte: range.from, lt: range.to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.orderItemVoid.groupBy({
      by: ["voidedBy"],
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
      _sum: { voidedValue: true },
    }),
    prisma.shift.findMany({
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, status: "CLOSED", closedAt: { gte: range.from, lt: range.to } },
      select: { closedBy: true, cashDifference: true },
    }),
  ]);

  interface Bucket {
    orders: number;
    sales: Prisma.Decimal;
    cash: Prisma.Decimal;
    card: Prisma.Decimal;
    voidCount: number;
    voidValue: Prisma.Decimal;
    cashDifference: Prisma.Decimal;
    shiftsClosedCount: number;
  }
  const byEmployee = new Map<string, Bucket>();
  const bucketFor = (id: string): Bucket => {
    let b = byEmployee.get(id);
    if (!b) {
      b = {
        orders: 0,
        sales: new Prisma.Decimal(0),
        cash: new Prisma.Decimal(0),
        card: new Prisma.Decimal(0),
        voidCount: 0,
        voidValue: new Prisma.Decimal(0),
        cashDifference: new Prisma.Decimal(0),
        shiftsClosedCount: 0,
      };
      byEmployee.set(id, b);
    }
    return b;
  };

  for (const g of salesGroups) {
    const b = bucketFor(g.completedBy);
    b.orders += g._count._all;
    const amount = new Prisma.Decimal(g._sum.amount ?? 0);
    b.sales = b.sales.add(amount);
    if (g.method === "CASH") b.cash = b.cash.add(amount);
    else b.card = b.card.add(amount);
  }
  for (const g of voidGroups) {
    const b = bucketFor(g.voidedBy);
    b.voidCount = g._count._all;
    b.voidValue = new Prisma.Decimal(g._sum.voidedValue ?? 0);
  }
  for (const s of closedShifts) {
    if (!s.closedBy) continue;
    const b = bucketFor(s.closedBy);
    b.cashDifference = b.cashDifference.add(s.cashDifference ?? 0);
    b.shiftsClosedCount += 1;
  }

  const employeeIds = Array.from(byEmployee.keys());
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, employeeIds);

  return employeeIds
    .map((id) => {
      const b = byEmployee.get(id) as Bucket;
      return {
        employeeId: id,
        employeeName: nameById.get(id)?.name ?? "?",
        role: nameById.get(id)?.role ?? "?",
        completedOrders: b.orders,
        sales: b.sales.toString(),
        cashHandled: b.cash.toString(),
        cardHandled: b.card.toString(),
        voidCount: b.voidCount,
        voidValue: b.voidValue.toString(),
        shiftsClosedCount: b.shiftsClosedCount,
        cashDifference: b.shiftsClosedCount > 0 ? b.cashDifference.toString() : null,
      };
    })
    .sort((a, b) => Number(b.sales) - Number(a.sales));
}

// ── AKTIVNOST / AUDIT (čitljiv prevod) ──────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Prijava zaposlenog (email)",
  "auth.pin_login": "Prijava zaposlenog (PIN)",
  "order.submitted": "Porudžbina poslata",
  "payment.completed": "Plaćanje završeno",
  "shift.opened": "Smena otvorena",
  "shift.closed": "Smena zatvorena",
  "order_item.voided_full": "Stavka poništena",
  "order_item.voided_partial": "Količina stavke umanjena (delimično poništavanje)",
  "order_item.mutation_attempt_rejected": "Pokušaj izmene već poslate stavke odbijen",
  "order_item.void_attempt_rejected": "Pokušaj poništavanja odbijen — nema ovlašćenje",
  "menu_category.created": "Kategorija menija kreirana",
  "menu_category.updated": "Kategorija menija izmenjena",
  "menu_item.created": "Artikal menija kreiran",
  "menu_item.updated": "Artikal menija izmenjen",
  "menu_item.price_changed": "Cena artikla izmenjena",
  "employee.created": "Zaposleni kreiran",
  "employee.updated": "Podaci zaposlenog izmenjeni",
  "employee.pin_reset": "PIN zaposlenog resetovan",
  "employee.deactivated": "Zaposleni deaktiviran",
  "employee.reactivated": "Zaposleni reaktiviran",
  "auth.terminal_locked": "Terminal zaključan (Quick Lock)",
  "device.registered": "Uređaj registrovan za PIN prijavu",
};

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface ActivityLogRow {
  id: string;
  action: string;
  label: string;
  employeeName: string;
  role: string;
  severity: "INFO" | "WARNING" | "HIGH";
  isSuspicious: boolean;
  reason: string | null;
  createdAt: string;
}

export async function getActivityLog(
  ctx: AuthContext,
  filters: ReportFilters & { onlySuspicious?: boolean }
): Promise<ActivityLogRow[]> {
  const { locationIds, range } = await resolveContext(ctx, filters);
  const allLocations = filters.locationId === "ALL";

  const entries = await prisma.auditLog.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      createdAt: { gte: range.from, lt: range.to },
      ...(filters.onlySuspicious ? { isSuspicious: true } : {}),
      // Redovi bez locationId (npr. auth.login pre nego što je poznat
      // uređaj) se prikazuju SAMO kad je filter "Sve lokacije" — nikad kad
      // je izabrana konkretna lokacija (ne znamo da li joj pripadaju).
      ...(allLocations ? {} : { locationId: { in: locationIds } }),
    },
    orderBy: { createdAt: "desc" },
    take: LIST_ROW_CAP,
  });
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, entries.map((e) => e.userId));

  return entries.map((e) => ({
    id: e.id,
    action: e.action,
    label: humanizeAction(e.action),
    employeeName: e.userId ? (nameById.get(e.userId)?.name ?? "?") : "Sistem",
    role: e.role ?? "?",
    severity: e.severity,
    isSuspicious: e.isSuspicious,
    reason: e.reason,
    createdAt: e.createdAt.toISOString(),
  }));
}

// ── PRODATI ARTIKLI ─────────────────────────────────────────────────────

export type SoldItemsStationFilter = "ALL" | "KITCHEN" | "BAR";

export interface SoldItemRow {
  name: string;
  station: string;
  categoryName: string | null;
  totalQuantity: number;
  totalRevenue: string;
  avgPrice: string;
}

export interface SoldItemsSummary {
  allQuantity: number;
  allRevenue: string;
  kitchenQuantity: number;
  kitchenRevenue: string;
  barQuantity: number;
  barRevenue: string;
}

export interface SoldItemsReport {
  range: { from: string; to: string };
  currency: string;
  station: SoldItemsStationFilter;
  rows: SoldItemRow[];
  summary: SoldItemsSummary;
}

export interface RawSoldItem {
  name: string;
  price: Prisma.Decimal | string | number;
  quantity: number;
  preparationStation: string;
  menuItem: { category: { name: string } | null } | null;
}

/**
 * Cista agregaciona funkcija — ne dirá bazu, uzima vec ucitane rawItems.
 * Eksportovana radi unit testabilnosti (tests/unit/sold-items-attribution).
 *
 * KITCHEN_AND_BAR pravilo: finansijski se pripisuje ISKLJUCIVO kuhinji
 * (kitchenRevenue), nikad sanku — sprecava duplo brojanje istog prihoda.
 */
export function aggregateSoldItems(
  rawItems: RawSoldItem[],
  station: SoldItemsStationFilter
): { rows: SoldItemRow[]; summary: SoldItemsSummary } {
  interface Bucket {
    name: string;
    station: string;
    categoryName: string | null;
    qty: number;
    revenue: Prisma.Decimal;
  }
  const buckets = new Map<string, Bucket>();

  let allQuantity = 0;
  let allRevenue = new Prisma.Decimal(0);
  let kitchenQuantity = 0;
  let kitchenRevenue = new Prisma.Decimal(0);
  let barQuantity = 0;
  let barRevenue = new Prisma.Decimal(0);

  for (const item of rawItems) {
    const lineRevenue = new Prisma.Decimal(item.price).mul(item.quantity);
    allQuantity += item.quantity;
    allRevenue = allRevenue.add(lineRevenue);

    const st = item.preparationStation;
    if (st === "KITCHEN" || st === "KITCHEN_AND_BAR") {
      kitchenQuantity += item.quantity;
      kitchenRevenue = kitchenRevenue.add(lineRevenue);
    } else if (st === "BAR") {
      barQuantity += item.quantity;
      barRevenue = barRevenue.add(lineRevenue);
    }

    const key = `${item.name}::${st}`;
    const b = buckets.get(key);
    if (b) {
      b.qty += item.quantity;
      b.revenue = b.revenue.add(lineRevenue);
    } else {
      buckets.set(key, {
        name: item.name,
        station: st,
        categoryName: item.menuItem?.category?.name ?? null,
        qty: item.quantity,
        revenue: lineRevenue,
      });
    }
  }

  let rows = Array.from(buckets.values());
  if (station === "KITCHEN") {
    rows = rows.filter((r) => r.station === "KITCHEN" || r.station === "KITCHEN_AND_BAR");
  } else if (station === "BAR") {
    rows = rows.filter((r) => r.station === "BAR");
  }

  const sortedRows = rows
    .sort((a, b) => b.revenue.cmp(a.revenue))
    .slice(0, LIST_ROW_CAP)
    .map((r) => ({
      name: r.name,
      station: r.station,
      categoryName: r.categoryName,
      totalQuantity: r.qty,
      totalRevenue: r.revenue.toString(),
      avgPrice: r.qty > 0 ? r.revenue.div(r.qty).toDecimalPlaces(2).toString() : "0",
    }));

  return {
    rows: sortedRows,
    summary: {
      allQuantity,
      allRevenue: allRevenue.toString(),
      kitchenQuantity,
      kitchenRevenue: kitchenRevenue.toString(),
      barQuantity,
      barRevenue: barRevenue.toString(),
    },
  };
}

/**
 * Prodati artikli — grupisan po nazivu i stanici za izabrani period.
 *
 * IZVOR ISTINE: Payment.completedAt + OrderItem.price (snapshot zamrznjen u
 * trenutku porudžbine) — izmena cene artikla sutra ne menja istorijski
 * izveštaj. Poništene stavke su automatski isključene jer OrderItem.quantity
 * odražava preostalu količinu posle svakog void-a, a CANCELLED stavke se
 * eksplicitno filtriraju.
 *
 * ATRIBUCIJA KUHINJA_AND_BAR: Artikli sa stanicom KITCHEN_AND_BAR se
 * finansijski pripisuju Kuhinji (kitchenRevenue). Na taj način zbir
 * kitchenRevenue + barRevenue uvek tačno iznosi allRevenue — nema
 * dupliranja istog RSD iznosa i u Kuhinji i u Šanku. Filter "Kuhinja"
 * prikazuje KITCHEN + KITCHEN_AND_BAR; filter "Šank" prikazuje samo BAR.
 */
export async function getSoldItems(
  ctx: AuthContext,
  filters: ReportFilters,
  station: SoldItemsStationFilter = "ALL"
): Promise<SoldItemsReport> {
  const { locationIds, range, currency } = await resolveContext(ctx, filters);

  const payments = await prisma.payment.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      locationId: { in: locationIds },
      completedAt: { gte: range.from, lt: range.to },
    },
    select: { orderId: true },
  });

  const orderIds = payments.map((p) => p.orderId);
  const emptyRange = { from: range.from.toISOString(), to: range.to.toISOString() };
  const emptySummary: SoldItemsSummary = {
    allQuantity: 0,
    allRevenue: "0",
    kitchenQuantity: 0,
    kitchenRevenue: "0",
    barQuantity: 0,
    barRevenue: "0",
  };
  if (orderIds.length === 0) {
    return { range: emptyRange, currency, station, rows: [], summary: emptySummary };
  }

  const rawItems = await prisma.orderItem.findMany({
    where: { orderId: { in: orderIds }, status: { not: "CANCELLED" } },
    select: {
      name: true,
      price: true,
      quantity: true,
      preparationStation: true,
      menuItem: { select: { category: { select: { name: true } } } },
    },
  });

  const { rows, summary } = aggregateSoldItems(rawItems, station);
  return { range: emptyRange, currency, station, rows, summary };
}
