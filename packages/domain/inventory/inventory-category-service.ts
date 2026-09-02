/**
 * P1.5: Hijerarhijska kategorija FIZIČKE ZALIHE (InventoryCategory) —
 * NAMERNO odvojena od MenuCategory (menu-service.ts), koja organizuje šta se
 * PRODAJE. Ova organizuje fizičku ROBU koju restoran drži na stanju —
 * KUHINJA/ŠANK -> podkategorija — dodeljivu i sirovinama (Ingredient) i
 * direct-stock artiklima (MenuItem, npr. Coca-Cola -> ŠANK -> Sokovi).
 * Nikad ne utiče na naplatu/odbitak — čisto organizaciono/UX polje.
 *
 * Permisije: ponovo se koristi postojeći 'inventory.manage' (OWNER/ADMIN/
 * MANAGER) — ista operativna granica kao ostatak sirovinskog/zaliha modula,
 * nema potrebe za novim permission kodom.
 */
import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";

export interface InventoryCategoryInput {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}

async function loadOwnedCategory(ctx: AuthContext, id: string) {
  const category = await prisma.inventoryCategory.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!category) throw new Error("Kategorija zaliha nije pronađena");
  return category;
}

/**
 * Flat lista (isti obrazac kao menu-service.ts listCategories) — UI gradi
 * KUHINJA/ŠANK -> podkategorija prikaz iz parentId/sortOrder polja. Uključuje
 * neaktivne (isActive=false) da bi Admin i dalje mogao da ih vidi/reaktivira;
 * potrošačke liste (Sirovine/Zalihe) filtriraju isActive na klijentu.
 */
export async function listInventoryCategories(ctx: AuthContext) {
  requirePermission(ctx, "inventory.view");
  return prisma.inventoryCategory.findMany({
    where: scopeToRestaurant(ctx),
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createInventoryCategory(ctx: AuthContext, input: InventoryCategoryInput) {
  requirePermission(ctx, "inventory.manage");
  const name = input.name.trim();
  if (!name) throw new Error("Naziv kategorije je obavezan");

  if (input.parentId) {
    const parent = await loadOwnedCategory(ctx, input.parentId);
    if (!parent.isActive) throw new Error("Ne može se dodati podkategorija u deaktiviranu kategoriju");
  }

  const category = await prisma.inventoryCategory.create({
    data: { restaurantId: ctx.restaurantId, name, parentId: input.parentId ?? null, sortOrder: input.sortOrder ?? 0 },
  });

  await recordAuditEntry(ctx, {
    entityType: "InventoryCategory",
    entityId: category.id,
    action: "inventory_category.created",
    newValue: { name, parentId: input.parentId ?? null },
  });
  return category;
}

export async function renameInventoryCategory(ctx: AuthContext, id: string, name: string) {
  requirePermission(ctx, "inventory.manage");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Naziv kategorije je obavezan");
  const existing = await loadOwnedCategory(ctx, id);

  const updated = await prisma.inventoryCategory.update({ where: { id }, data: { name: trimmed } });

  await recordAuditEntry(ctx, {
    entityType: "InventoryCategory",
    entityId: id,
    action: "inventory_category.renamed",
    previousValue: { name: existing.name },
    newValue: { name: trimmed },
  });
  return updated;
}

/**
 * Deaktivacija umesto brisanja (isti obrazac kao Ingredient/MenuItem) —
 * brisanje kategorije koja ima dodeljene sirovine/artikle bi ih osirotilo.
 * Deca (podkategorije) se NE diraju automatski — administrator ih
 * eksplicitno deaktivira zasebno ako je to namera (izbegava iznenadno
 * masovno gašenje cele KUHINJA/ŠANK grane jednim klikom).
 */
export async function deactivateInventoryCategory(ctx: AuthContext, id: string) {
  requirePermission(ctx, "inventory.manage");
  const existing = await loadOwnedCategory(ctx, id);
  if (!existing.isActive) throw new Error("Kategorija je već deaktivirana");

  const updated = await prisma.inventoryCategory.update({ where: { id }, data: { isActive: false } });

  await recordAuditEntry(ctx, {
    entityType: "InventoryCategory",
    entityId: id,
    action: "inventory_category.deactivated",
    newValue: { name: existing.name },
  });
  return updated;
}

export async function activateInventoryCategory(ctx: AuthContext, id: string) {
  requirePermission(ctx, "inventory.manage");
  const existing = await loadOwnedCategory(ctx, id);
  if (existing.isActive) throw new Error("Kategorija je već aktivna");

  const updated = await prisma.inventoryCategory.update({ where: { id }, data: { isActive: true } });

  await recordAuditEntry(ctx, {
    entityType: "InventoryCategory",
    entityId: id,
    action: "inventory_category.activated",
    newValue: { name: existing.name },
  });
  return updated;
}

/** Isti obrazac kao menu-service.ts moveToCategory — validira vlasništvo pre dodele, null uklanja dodelu ("Nekategorisano"). */
export async function setIngredientInventoryCategory(ctx: AuthContext, ingredientId: string, inventoryCategoryId: string | null) {
  requirePermission(ctx, "inventory.manage");
  const ingredient = await prisma.ingredient.findFirst({ where: { id: ingredientId, ...scopeToRestaurant(ctx) } });
  if (!ingredient) throw new Error("Sirovina nije pronađena");

  if (inventoryCategoryId) {
    const category = await loadOwnedCategory(ctx, inventoryCategoryId);
    if (!category.isActive) throw new Error("Kategorija zaliha je deaktivirana");
  }

  const updated = await prisma.ingredient.update({ where: { id: ingredientId }, data: { inventoryCategoryId } });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredientId,
    action: "ingredient.category_changed",
    previousValue: { inventoryCategoryId: ingredient.inventoryCategoryId },
    newValue: { inventoryCategoryId },
  });
  return updated;
}

/**
 * Direct-stock (resale) MenuItem dobija InventoryCategory dodelu za
 * organizaciju Zalihe ekrana (npr. Coca-Cola -> ŠANK -> Sokovi) — NIKAD ne
 * utiče na naplatu/odbitak (ta putanja ostaje isključivo InventoryItem/
 * trackStock, nepromenjena). `inventory.manage` (ne `menu.manage`) jer je
 * ovo organizaciona akcija nad zalihama, ne izmena menija.
 */
export async function setMenuItemInventoryCategory(ctx: AuthContext, menuItemId: string, inventoryCategoryId: string | null) {
  requirePermission(ctx, "inventory.manage");
  const menuItem = await prisma.menuItem.findFirst({ where: { id: menuItemId, ...scopeToRestaurant(ctx) } });
  if (!menuItem) throw new Error("Artikal nije pronađen");

  if (inventoryCategoryId) {
    const category = await loadOwnedCategory(ctx, inventoryCategoryId);
    if (!category.isActive) throw new Error("Kategorija zaliha je deaktivirana");
  }

  const updated = await prisma.menuItem.update({ where: { id: menuItemId }, data: { inventoryCategoryId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "menu_item.inventory_category_changed",
    previousValue: { inventoryCategoryId: menuItem.inventoryCategoryId },
    newValue: { inventoryCategoryId },
  });
  return updated;
}

const DEFAULT_KUHINJA_SUBCATEGORIES = [
  "Meso", "Piletina", "Riba", "Suhomesnato", "Sir i mlečni proizvodi", "Jaja",
  "Povrće", "Voće", "Salate / zimnica", "Pečurke", "Brašno / prezle",
  "Ulje / masnoće", "Začini", "Ostalo",
];
const DEFAULT_SANK_SUBCATEGORIES = [
  "Pivo", "Vino", "Žestoka pića", "Sokovi", "Voda", "Energetska pića", "Topli napici", "Ostalo",
];

/**
 * Kreira podrazumevanu KUHINJA/ŠANK hijerarhiju za restoran — IDEMPOTENTNO
 * (preskače nivoe koji već postoje po imenu, nikad ne pravi duplikate,
 * bezbedno za višestruko pokretanje). Ovo je POČETNA tačka, ne trajno
 * ograničenje — OWNER/ADMIN/MANAGER mogu slobodno preimenovati/dodati/
 * deaktivirati kategorije posle ovoga (§3/§4 zahtev: "ne hardkodovati listu
 * kategorija u logiku aplikacije trajno").
 */
export async function seedDefaultInventoryCategories(ctx: AuthContext) {
  requirePermission(ctx, "inventory.manage");

  async function ensureTop(name: string, sortOrder: number) {
    const existing = await prisma.inventoryCategory.findFirst({
      where: { restaurantId: ctx.restaurantId, parentId: null, name },
    });
    if (existing) return existing;
    return prisma.inventoryCategory.create({
      data: { restaurantId: ctx.restaurantId, name, parentId: null, sortOrder },
    });
  }

  async function ensureChild(parentId: string, name: string, sortOrder: number) {
    const existing = await prisma.inventoryCategory.findFirst({
      where: { restaurantId: ctx.restaurantId, parentId, name },
    });
    if (existing) return existing;
    return prisma.inventoryCategory.create({
      data: { restaurantId: ctx.restaurantId, name, parentId, sortOrder },
    });
  }

  const kuhinja = await ensureTop("KUHINJA", 0);
  const sank = await ensureTop("ŠANK", 1);

  const created: string[] = [];
  for (let i = 0; i < DEFAULT_KUHINJA_SUBCATEGORIES.length; i++) {
    const before = await prisma.inventoryCategory.count({ where: { restaurantId: ctx.restaurantId, parentId: kuhinja.id, name: DEFAULT_KUHINJA_SUBCATEGORIES[i] } });
    await ensureChild(kuhinja.id, DEFAULT_KUHINJA_SUBCATEGORIES[i], i);
    if (before === 0) created.push(`KUHINJA > ${DEFAULT_KUHINJA_SUBCATEGORIES[i]}`);
  }
  for (let i = 0; i < DEFAULT_SANK_SUBCATEGORIES.length; i++) {
    const before = await prisma.inventoryCategory.count({ where: { restaurantId: ctx.restaurantId, parentId: sank.id, name: DEFAULT_SANK_SUBCATEGORIES[i] } });
    await ensureChild(sank.id, DEFAULT_SANK_SUBCATEGORIES[i], i);
    if (before === 0) created.push(`ŠANK > ${DEFAULT_SANK_SUBCATEGORIES[i]}`);
  }

  await recordAuditEntry(ctx, {
    entityType: "InventoryCategory",
    entityId: ctx.restaurantId,
    action: "inventory_category.defaults_seeded",
    newValue: { createdCount: created.length, created },
  });

  return listInventoryCategories(ctx);
}
