import { ForbiddenError, type AuthContext } from "@rcs/auth";

const MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

export function isOrderManager(ctx: Pick<AuthContext, "roles">): boolean {
  return ctx.roles.some((role) => MANAGEMENT_ROLES.has(role));
}

export function requireOrderOperator(ctx: Pick<AuthContext, "roles">): void {
  if (isOrderManager(ctx) || ctx.roles.includes("WAITER")) return;
  throw new ForbiddenError("Nemaš dozvolu za rad sa konobarskim porudžbinama");
}

export function requireDraftOwnership(
  ctx: Pick<AuthContext, "roles" | "employeeId">,
  openedBy: string
): void {
  requireOrderOperator(ctx);
  if (isOrderManager(ctx) || openedBy === ctx.employeeId) return;
  throw new ForbiddenError("Ovu porudžbinu je otvorio drugi konobar");
}

/**
 * Poništavanje/redukcija VEĆ POSLATE stavke (Faza 4) je namerno ograničeno
 * na menadžment (OWNER/ADMIN/MANAGER) — za razliku od DRAFT izmena koje
 * konobar radi slobodno. Ovo je najosetljivija tačka za zloupotrebu
 * (konobar bi mogao da "poništi" prodatu stavku i zadrži gotovinu), pa
 * cilj "otežati zloupotrebu zaposlenih" preteže nad brzinom — konobar
 * traži menadžera da izvrši/odobri poništavanje, ista praksa kao u većini
 * pravih restoranskih POS sistema.
 */
export function requireVoidAuthority(ctx: Pick<AuthContext, "roles">): void {
  if (isOrderManager(ctx)) return;
  throw new ForbiddenError("Samo menadžer ili vlasnik može poništiti poslatu stavku");
}
