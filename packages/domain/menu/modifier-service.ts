/**
 * P3.2 — Menu Modifiers & Extras.
 *
 * Admin CRUD (grupe/opcije/vezivanje za MenuItem) živi ovde, uz istu
 * permisiju kao ostatak Menu administracije ("menu.manage"/"menu.view" —
 * vidi menu-service.ts, isti razlog: WAITER/KITCHEN/BAR nikad ne dobijaju
 * menu.manage u seed podacima).
 *
 * `validateAndPriceModifierSelection` je ČISTA funkcija (bez baze) — poziva
 * je order-service.ts posle učitavanja SAMO grupa stvarno vezanih za dati
 * MenuItem, što je i provera "opcija pripada grupi koja pripada artiklu"
 * (specifikacija #12): opcija koja nije u prosleđenim grupama je nepoznata,
 * bez obzira da li postoji u bazi za NEKI drugi artikal/restoran.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type {
  CreateModifierGroupInput,
  UpdateModifierGroupInput,
  CreateModifierOptionInput,
  UpdateModifierOptionInput,
} from "@rcs/shared";

const MENU_MANAGE = "menu.manage";
const MENU_VIEW = "menu.view";

// ── ČISTA validacija/cenovanje (bez baze — unit-testabilno) ────────────────

export interface ModifierOptionForValidation {
  id: string;
  name: string;
  priceDelta: Prisma.Decimal | string | number;
  isActive: boolean;
}

export interface ModifierGroupForValidation {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: ModifierOptionForValidation[];
}

export interface ModifierSnapshotRow {
  modifierOptionId: string;
  groupName: string;
  optionName: string;
  priceDelta: Prisma.Decimal;
  sortOrder: number;
}

export interface ModifierSelectionResult {
  priceDelta: Prisma.Decimal;
  snapshotRows: ModifierSnapshotRow[];
}

/**
 * Validira izabrane opcije protiv grupa STVARNO vezanih za dati MenuItem
 * (pozivalac mora proslediti TAČNO taj skup — vidi napomenu na vrhu fajla)
 * i vraća zbir price delta vrednosti + redove za istorijski snapshot.
 * Baca grešku na prvi nevažeći uslov — nikad tiho ne ignoriše nevalidan unos
 * (specifikacija #12/#13: klijent šalje SAMO identitete, server presuđuje).
 */
export function validateAndPriceModifierSelection(
  groups: ModifierGroupForValidation[],
  selectedOptionIds: string[]
): ModifierSelectionResult {
  const uniqueSelected = Array.from(new Set(selectedOptionIds));

  const optionIndex = new Map<string, { group: ModifierGroupForValidation; option: ModifierOptionForValidation }>();
  for (const group of groups) {
    for (const option of group.options) {
      optionIndex.set(option.id, { group, option });
    }
  }

  const selectedByGroup = new Map<string, string[]>();
  for (const optionId of uniqueSelected) {
    const found = optionIndex.get(optionId);
    if (!found) throw new Error("Izabrana opcija dodatka ne pripada ovom artiklu ili ne postoji");
    if (!found.group.isActive) throw new Error(`Grupa dodataka "${found.group.name}" trenutno nije aktivna`);
    if (!found.option.isActive) throw new Error(`Opcija "${found.option.name}" trenutno nije dostupna`);
    const list = selectedByGroup.get(found.group.id) ?? [];
    list.push(optionId);
    selectedByGroup.set(found.group.id, list);
  }

  for (const group of groups) {
    if (!group.isActive) continue; // neaktivna grupa se ne prikazuje niti validira
    const selected = selectedByGroup.get(group.id) ?? [];
    if (group.required && selected.length === 0) {
      throw new Error(`Grupa "${group.name}" zahteva izbor`);
    }
    if (selected.length < group.minSelect) {
      throw new Error(`Grupa "${group.name}" zahteva najmanje ${group.minSelect} izbora`);
    }
    if (selected.length > group.maxSelect) {
      throw new Error(`Grupa "${group.name}" dozvoljava najviše ${group.maxSelect} izbora`);
    }
  }

  let priceDelta = new Prisma.Decimal(0);
  const snapshotRows: ModifierSnapshotRow[] = uniqueSelected.map((optionId, index) => {
    const { group, option } = optionIndex.get(optionId)!;
    const delta = new Prisma.Decimal(option.priceDelta);
    priceDelta = priceDelta.add(delta);
    return { modifierOptionId: option.id, groupName: group.name, optionName: option.name, priceDelta: delta, sortOrder: index };
  });

  return { priceDelta, snapshotRows };
}

/** Grupe STVARNO vezane za dati MenuItem, sa aktivnim+neaktivnim opcijama
 * (validacija gore sama odbacuje neaktivne) — jedan upit, ne po grupi. */
export async function getModifierGroupsForMenuItem(restaurantId: string, menuItemId: string): Promise<ModifierGroupForValidation[]> {
  const links = await prisma.menuItemModifierGroup.findMany({
    where: { menuItemId, group: { restaurantId } },
    include: { group: { include: { options: { orderBy: { sortOrder: "asc" } } } } },
    orderBy: { sortOrder: "asc" },
  });
  return links.map((l) => ({
    id: l.group.id,
    name: l.group.name,
    required: l.group.required,
    minSelect: l.group.minSelect,
    maxSelect: l.group.maxSelect,
    isActive: l.group.isActive,
    options: l.group.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, isActive: o.isActive })),
  }));
}

// ── Admin CRUD ──────────────────────────────────────────────────────────

export async function listModifierGroups(ctx: AuthContext) {
  requirePermission(ctx, MENU_VIEW);
  return prisma.modifierGroup.findMany({
    where: scopeToRestaurant(ctx),
    include: {
      options: { orderBy: { sortOrder: "asc" } },
      menuItems: { include: { menuItem: { select: { id: true, name: true } } } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createModifierGroup(ctx: AuthContext, input: CreateModifierGroupInput) {
  requirePermission(ctx, MENU_MANAGE);
  if (input.minSelect > input.maxSelect) {
    throw new Error("Minimalan broj izbora ne može biti veći od maksimalnog");
  }
  const group = await prisma.modifierGroup.create({
    data: { ...input, restaurantId: ctx.restaurantId },
  });
  await recordAuditEntry(ctx, {
    entityType: "ModifierGroup",
    entityId: group.id,
    action: "modifier_group.created",
    newValue: input,
  });
  return group;
}

async function getOwnedGroup(ctx: AuthContext, groupId: string) {
  const group = await prisma.modifierGroup.findFirst({ where: { id: groupId, ...scopeToRestaurant(ctx) } });
  if (!group) throw new Error("Grupa dodataka nije pronađena");
  return group;
}

export async function updateModifierGroup(ctx: AuthContext, groupId: string, input: UpdateModifierGroupInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedGroup(ctx, groupId);
  const nextMin = input.minSelect ?? existing.minSelect;
  const nextMax = input.maxSelect ?? existing.maxSelect;
  if (nextMin > nextMax) {
    throw new Error("Minimalan broj izbora ne može biti veći od maksimalnog");
  }

  const updated = await prisma.modifierGroup.update({ where: { id: groupId }, data: input });
  await recordAuditEntry(ctx, {
    entityType: "ModifierGroup",
    entityId: groupId,
    action: "modifier_group.updated",
    previousValue: { name: existing.name, required: existing.required, minSelect: existing.minSelect, maxSelect: existing.maxSelect },
    newValue: input,
  });
  return updated;
}

export async function setModifierGroupActive(ctx: AuthContext, groupId: string, isActive: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedGroup(ctx, groupId);
  const updated = await prisma.modifierGroup.update({ where: { id: groupId }, data: { isActive } });
  await recordAuditEntry(ctx, {
    entityType: "ModifierGroup",
    entityId: groupId,
    action: isActive ? "modifier_group.enabled" : "modifier_group.disabled",
    previousValue: { isActive: existing.isActive },
    newValue: { isActive },
  });
  return updated;
}

async function getOwnedOption(ctx: AuthContext, optionId: string) {
  const option = await prisma.modifierOption.findFirst({
    where: { id: optionId, group: scopeToRestaurant(ctx) },
    include: { group: true },
  });
  if (!option) throw new Error("Opcija dodatka nije pronađena");
  return option;
}

export async function createModifierOption(ctx: AuthContext, groupId: string, input: CreateModifierOptionInput) {
  requirePermission(ctx, MENU_MANAGE);
  await getOwnedGroup(ctx, groupId);

  const option = await prisma.modifierOption.create({
    data: { ...input, modifierGroupId: groupId },
  });
  await recordAuditEntry(ctx, {
    entityType: "ModifierOption",
    entityId: option.id,
    action: "modifier_option.created",
    newValue: { ...input, modifierGroupId: groupId },
  });
  return option;
}

export async function updateModifierOption(ctx: AuthContext, optionId: string, input: UpdateModifierOptionInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedOption(ctx, optionId);

  const updated = await prisma.modifierOption.update({ where: { id: optionId }, data: input });
  await recordAuditEntry(ctx, {
    entityType: "ModifierOption",
    entityId: optionId,
    action: input.priceDelta !== undefined && Number(input.priceDelta) !== Number(existing.priceDelta)
      ? "modifier_option.price_changed"
      : "modifier_option.updated",
    previousValue: { name: existing.name, priceDelta: existing.priceDelta.toString() },
    newValue: input,
  });
  return updated;
}

export async function setModifierOptionActive(ctx: AuthContext, optionId: string, isActive: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedOption(ctx, optionId);
  const updated = await prisma.modifierOption.update({ where: { id: optionId }, data: { isActive } });
  await recordAuditEntry(ctx, {
    entityType: "ModifierOption",
    entityId: optionId,
    action: isActive ? "modifier_option.enabled" : "modifier_option.disabled",
    previousValue: { isActive: existing.isActive },
    newValue: { isActive },
  });
  return updated;
}

// ── Vezivanje grupa za MenuItem ─────────────────────────────────────────

export async function attachModifierGroupToItem(ctx: AuthContext, menuItemId: string, groupId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const [item, group] = await Promise.all([
    prisma.menuItem.findFirst({ where: { id: menuItemId, ...scopeToRestaurant(ctx), deletedAt: null } }),
    getOwnedGroup(ctx, groupId),
  ]);
  if (!item) throw new Error("Artikal nije pronađen");

  const existing = await prisma.menuItemModifierGroup.findUnique({
    where: { menuItemId_modifierGroupId: { menuItemId, modifierGroupId: groupId } },
  });
  if (existing) return existing; // idempotentno — ponovna vezivanja se tiho ignorišu

  const maxSort = await prisma.menuItemModifierGroup.aggregate({ where: { menuItemId }, _max: { sortOrder: true } });
  const link = await prisma.menuItemModifierGroup.create({
    data: { menuItemId, modifierGroupId: groupId, sortOrder: (maxSort._max.sortOrder ?? -1) + 1 },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "menu_item.modifier_group_attached",
    newValue: { modifierGroupId: groupId, groupName: group.name },
  });
  return link;
}

export async function detachModifierGroupFromItem(ctx: AuthContext, menuItemId: string, groupId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, ...scopeToRestaurant(ctx) } });
  if (!item) throw new Error("Artikal nije pronađen");

  await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId, modifierGroupId: groupId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "menu_item.modifier_group_detached",
    newValue: { modifierGroupId: groupId },
  });
}

export async function listModifierGroupsForItem(ctx: AuthContext, menuItemId: string) {
  requirePermission(ctx, MENU_VIEW);
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, ...scopeToRestaurant(ctx) } });
  if (!item) throw new Error("Artikal nije pronađen");
  return getModifierGroupsForMenuItem(ctx.restaurantId, menuItemId);
}
