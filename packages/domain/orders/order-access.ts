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
