import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  ReorderCategoriesInput,
  CreateMenuItemInput,
  UpdateMenuItemInput,
  ChangePriceInput,
  MoveToCategoryInput,
  MenuItemFilters,
} from "@rcs/shared";

// Jedina permisija koja pokriva izmenu menija u MVP-u — namerno bez
// finije granulacije (menu.price.edit, menu.availability, ...) dok se ne
// pokaže stvarna potreba (vidi "ne praviti preranu apstrakciju" u planu).
// Ono što JESTE tvrdo zagarantovano: WAITER/KITCHEN/BAR role u seed
// podacima nikad ne dobijaju ovu permisiju (vidi seed.ts).
const MENU_MANAGE = "menu.manage";
const MENU_VIEW = "menu.view";

// ── KATEGORIJE ──────────────────────────────────────────────────────────

export async function listCategories(ctx: AuthContext) {
  requirePermission(ctx, MENU_VIEW);
  return prisma.menuCategory.findMany({
    where: scopeToRestaurant(ctx),
    orderBy: { sortOrder: "asc" },
  });
}

export async function createCategory(ctx: AuthContext, input: CreateCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const category = await prisma.menuCategory.create({
    data: { ...input, restaurantId: ctx.restaurantId },
  });
  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: category.id,
    action: "menu_category.created",
    newValue: input,
  });
  return category;
}

export async function updateCategory(ctx: AuthContext, categoryId: string, input: UpdateCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await prisma.menuCategory.findFirst({
    where: { id: categoryId, ...scopeToRestaurant(ctx) },
  });
  if (!existing) throw new Error("Kategorija nije pronađena");

  const updated = await prisma.menuCategory.update({
    where: { id: categoryId },
    data: input,
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: categoryId,
    action: "menu_category.updated",
    previousValue: { name: existing.name, isActive: existing.isActive, sortOrder: existing.sortOrder },
    newValue: input,
  });
  return updated;
}

export async function reorderCategories(ctx: AuthContext, input: ReorderCategoriesInput) {
  requirePermission(ctx, MENU_MANAGE);

  const owned = await prisma.menuCategory.findMany({
    where: { id: { in: input.orderedIds }, ...scopeToRestaurant(ctx) },
    select: { id: true },
  });
  if (owned.length !== input.orderedIds.length) {
    throw new Error("Jedna ili više kategorija ne pripada ovom restoranu");
  }

  await prisma.$transaction(
    input.orderedIds.map((id, index) =>
      prisma.menuCategory.update({ where: { id }, data: { sortOrder: index } })
    )
  );

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: "bulk-reorder",
    action: "menu_category.reordered",
    newValue: { orderedIds: input.orderedIds },
  });
}

/**
 * Brisanje kategorije koja ima dodeljene artikle je dozvoljeno (FK je
 * ON DELETE SET NULL — artikli postaju "nekategorisani", ne brišu se), ali
 * zahteva eksplicitnu potvrdu (`force`) da administrator ne obriše
 * kategoriju slučajno dok u njoj ima 40 artikala.
 */
export async function deleteCategory(ctx: AuthContext, categoryId: string, force = false) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await prisma.menuCategory.findFirst({
    where: { id: categoryId, ...scopeToRestaurant(ctx) },
  });
  if (!existing) throw new Error("Kategorija nije pronađena");

  const itemCount = await prisma.menuItem.count({ where: { categoryId, deletedAt: null } });
  if (itemCount > 0 && !force) {
    throw new Error(
      `Kategorija ima ${itemCount} artikala. Prosledi force=true da ih premestiš u "nekategorisano" i obrišeš kategoriju.`
    );
  }

  await prisma.menuCategory.delete({ where: { id: categoryId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: categoryId,
    action: "menu_category.deleted",
    previousValue: { name: existing.name, affectedItemCount: itemCount },
  });
}

// ── ARTIKLI ─────────────────────────────────────────────────────────────

export async function listMenuItems(ctx: AuthContext, filters: MenuItemFilters = {}) {
  requirePermission(ctx, MENU_VIEW);

  return prisma.menuItem.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      deletedAt: null,
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.preparationStation ? { preparationStation: filters.preparationStation } : {}),
      ...(filters.activeOnly ? { isActive: true } : {}),
      ...(filters.search
        ? { name: { contains: filters.search, mode: "insensitive" as const } }
        : {}),
      ...(filters.type ? { category: { type: filters.type } } : {}),
    },
    include: {
      category: true,
      // P3.2: JEDAN batch-ovan include za sve stavke (ne upit po artiklu) —
      // waiter ekran ovim saznaje da li artikal ima grupe dodataka bez
      // dodatnih rundi ka serveru (specifikacija #63). Prazno za artikle
      // bez vezanih grupa — jeftino po redu.
      modifierGroups: {
        where: { group: { isActive: true } },
        include: { group: { include: { options: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } } } },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createMenuItem(ctx: AuthContext, input: CreateMenuItemInput) {
  requirePermission(ctx, MENU_MANAGE);

  if (input.categoryId) {
    const category = await prisma.menuCategory.findFirst({
      where: { id: input.categoryId, ...scopeToRestaurant(ctx) },
    });
    if (!category) throw new Error("Kategorija ne pripada ovom restoranu");
  }

  const item = await prisma.menuItem.create({
    data: { ...input, restaurantId: ctx.restaurantId },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: item.id,
    action: "menu_item.created",
    newValue: { name: input.name, price: input.price, categoryId: input.categoryId ?? null },
  });
  return item;
}

async function getOwnedItem(ctx: AuthContext, itemId: string) {
  const item = await prisma.menuItem.findFirst({
    where: { id: itemId, ...scopeToRestaurant(ctx), deletedAt: null },
  });
  if (!item) throw new Error("Artikal nije pronađen");
  return item;
}

/**
 * Opšta izmena artikla — NE koristi se za promenu cene (vidi changePrice)
 * niti za promenu kategorije (vidi moveToCategory) jer te promene imaju
 * sopstvenu, precizniju audit akciju koju vlasnik traži da posebno vidi.
 */
export async function updateMenuItem(ctx: AuthContext, itemId: string, input: UpdateMenuItemInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const { price: _ignoredPrice, categoryId: _ignoredCategoryId, ...rest } = input;

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: rest });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.updated",
    previousValue: existing,
    newValue: rest,
  });
  return updated;
}

export async function changePrice(ctx: AuthContext, itemId: string, input: ChangePriceInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: { price: input.price },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.price_changed",
    previousValue: { price: existing.price },
    newValue: { price: input.price },
    reason: input.reason,
  });
  return updated;
}

export async function moveToCategory(ctx: AuthContext, itemId: string, input: MoveToCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  if (input.categoryId) {
    const category = await prisma.menuCategory.findFirst({
      where: { id: input.categoryId, ...scopeToRestaurant(ctx) },
    });
    if (!category) throw new Error("Kategorija ne pripada ovom restoranu");
  }

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: { categoryId: input.categoryId },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.category_changed",
    previousValue: { categoryId: existing.categoryId },
    newValue: { categoryId: input.categoryId },
  });
  return updated;
}

export async function setAvailability(ctx: AuthContext, itemId: string, isAvailable: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: { isAvailable } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.availability_changed",
    previousValue: { isAvailable: existing.isAvailable },
    newValue: { isAvailable },
  });
  return updated;
}

export async function setActive(ctx: AuthContext, itemId: string, isActive: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: { isActive } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: isActive ? "menu_item.enabled" : "menu_item.disabled",
    previousValue: { isActive: existing.isActive },
    newValue: { isActive },
  });
  return updated;
}

export async function archiveMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: { deletedAt: new Date(), isActive: false },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.archived",
    previousValue: { name: existing.name, price: existing.price },
  });
  return updated;
}

/**
 * Fizičko brisanje. Bezbedno u MVP-u jer Order/OrderItem modeli (Faza 3)
 * čuvaju immutable snapshot naziva/cene u trenutku prodaje — ne referenciraju
 * MenuItem preko FK-a koji bi blokirao brisanje niti bi izgubili istorijske
 * podatke ako se MenuItem obriše kasnije.
 */
export async function deleteMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  await prisma.menuItem.delete({ where: { id: itemId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.deleted",
    previousValue: existing,
  });
}

export async function duplicateMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const baseSlug = `${existing.slug}-kopija`;
  let slug = baseSlug;
  let suffix = 2;
  while (await prisma.menuItem.findFirst({ where: { restaurantId: ctx.restaurantId, slug } })) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing;
  const duplicate = await prisma.menuItem.create({
    data: { ...rest, name: `${existing.name} (kopija)`, slug, isActive: false },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: duplicate.id,
    action: "menu_item.duplicated",
    newValue: { duplicatedFrom: itemId },
  });
  return duplicate;
}
