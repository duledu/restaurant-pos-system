/**
 * Jedan izvor istine za "koja rola ide na koju rutu" — koristi se i za
 * redirect posle login-a (API ruta) i za role-based route guard u svakom
 * layout.tsx (server-side, ne samo UI sakrivanje linka).
 */

const REDIRECT_PRIORITY: { roles: string[]; path: string }[] = [
  { roles: ["OWNER", "ADMIN"], path: "/admin" },
  { roles: ["MANAGER"], path: "/admin" },
  { roles: ["KITCHEN"], path: "/kitchen" },
  { roles: ["BAR"], path: "/bar" },
  { roles: ["WAITER"], path: "/waiter" },
  { roles: ["INVENTORY_MANAGER"], path: "/admin" },
];

export function resolveRedirectPath(roles: string[]): string {
  for (const rule of REDIRECT_PRIORITY) {
    if (rule.roles.some((r) => roles.includes(r))) return rule.path;
  }
  return "/login";
}

/** Role koje smeju pristupiti /admin/** rutama. */
export const ADMIN_ROLES = ["OWNER", "ADMIN", "MANAGER", "INVENTORY_MANAGER"];
/** Role koje smeju pristupiti /waiter/** rutama (management sme i ovde, za nadzor). */
export const WAITER_ROLES = ["WAITER", "OWNER", "ADMIN", "MANAGER"];
export const KITCHEN_ROLES = ["KITCHEN", "OWNER", "ADMIN", "MANAGER"];
export const BAR_ROLES = ["BAR", "OWNER", "ADMIN", "MANAGER"];
