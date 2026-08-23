/**
 * P1: Normativi/recepture — koje sirovine (i u kojoj količini) ulaze u JEDAN
 * MenuItem. Namerno odvojen fajl od menu-service.ts, isti obrazac kao
 * modifier-service.ts (srodna ali konceptualno odvojena celina).
 *
 * VAŽNO: ništa ovde se ne poziva iz order-service.ts/billing-service.ts.
 * Recepture ne troše sirovine automatski u ovoj fazi — vidi napomenu na vrhu
 * ingredient-service.ts.
 */
import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";

async function loadOwnedMenuItem(ctx: AuthContext, menuItemId: string) {
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  return menuItem;
}

/**
 * Puna receptura artikla — ingredient uključen radi naziva/jedinice bez
 * dodatnog poziva sa strane klijenta.
 */
export async function getRecipe(ctx: AuthContext, menuItemId: string) {
  requirePermission(ctx, "menu.view");
  await loadOwnedMenuItem(ctx, menuItemId);

  return prisma.menuItemIngredient.findMany({
    where: { menuItemId },
    include: { ingredient: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function addRecipeLine(
  ctx: AuthContext,
  menuItemId: string,
  input: { ingredientId: string; quantity: number }
) {
  requirePermission(ctx, "inventory.manage");
  await loadOwnedMenuItem(ctx, menuItemId);

  const ingredient = await prisma.ingredient.findFirst({
    where: { id: input.ingredientId, ...scopeToRestaurant(ctx) },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const existing = await prisma.menuItemIngredient.findUnique({
    where: { menuItemId_ingredientId: { menuItemId, ingredientId: input.ingredientId } },
  });
  if (existing) throw new Error("Ova sirovina je već u recepturi — izmenite postojeću liniju umesto dodavanja nove");

  const line = await prisma.menuItemIngredient.create({
    data: { menuItemId, ingredientId: input.ingredientId, quantity: input.quantity },
    include: { ingredient: true },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "recipe.line_added",
    newValue: { ingredientId: input.ingredientId, ingredientName: ingredient.name, quantity: input.quantity, unit: ingredient.unit },
  });

  return line;
}

export async function updateRecipeLine(ctx: AuthContext, recipeLineId: string, input: { quantity: number }) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const line = await prisma.menuItemIngredient.findFirst({
    where: { id: recipeLineId, menuItem: scopeToRestaurant(ctx) },
    include: { ingredient: true, menuItem: { select: { id: true } } },
  });
  if (!line) throw new Error("Linija recepture nije pronađena");

  const updated = await prisma.menuItemIngredient.update({
    where: { id: recipeLineId },
    data: { quantity: input.quantity },
    include: { ingredient: true },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: line.menuItem.id,
    action: "recipe.line_updated",
    previousValue: { ingredientId: line.ingredientId, quantity: line.quantity.toString() },
    newValue: { ingredientId: line.ingredientId, ingredientName: line.ingredient.name, quantity: input.quantity },
  });

  return updated;
}

export async function removeRecipeLine(ctx: AuthContext, recipeLineId: string) {
  requirePermission(ctx, "inventory.manage");

  const line = await prisma.menuItemIngredient.findFirst({
    where: { id: recipeLineId, menuItem: scopeToRestaurant(ctx) },
    include: { ingredient: true, menuItem: { select: { id: true } } },
  });
  if (!line) throw new Error("Linija recepture nije pronađena");

  await prisma.menuItemIngredient.delete({ where: { id: recipeLineId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: line.menuItem.id,
    action: "recipe.line_removed",
    previousValue: { ingredientId: line.ingredientId, ingredientName: line.ingredient.name, quantity: line.quantity.toString() },
  });

  return { removed: true };
}
