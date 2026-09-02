/**
 * P1.6: Configurable per-MenuItem inventory tracking method
 * (NO_TRACKING / DIRECT_STOCK / RECIPE) — MenuItem.inventoryTrackingMethod
 * je JEDINI autoritativni gate za odbitak/dostupnost, NIKAD izveden iz
 * MenuCategory. Zamenjuje raniju dinamičku trackStock+hasRecipe-postoji
 * proveru (getMenuItemIdsWithRecipes) strukturnom garancijom: jedna kolona
 * ne može istovremeno biti i DIRECT_STOCK i RECIPE.
 *
 * Pokriva: NO_TRACKING (bez ikakvog odbitka), DIRECT_STOCK (gotov proizvod),
 * RECIPE (normativ od sirovina), sva 4 pravca prelaska (istorija se čuva),
 * eksplicitnu garanciju "tačno jedan odbitak", dostupnost po metodi,
 * RecipeNotConfiguredError ("Normativ nije podešen"),
 * DirectStockStillPresentError (potvrda pre isključivanja), i RBAC.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients, recipes, inventory, billing, orders } from "@rcs/domain";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  categoryId: string;
  otherLocationId: string;
  otherRestaurantId: string;
}

function ownerCtx(fixture: Fixture, employeeId = "owner-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set([
      "inventory.view", "inventory.manage",
      "menu.view", "menu.manage",
      "orders.create", "orders.manage", "orders.submit", "orders.print",
      "shifts.manage", "audit.view",
    ]),
  };
}

function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["WAITER"],
    permissions: new Set(["menu.view", "orders.create", "orders.submit", "orders.print", "shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "TrackMethod tenant", slug: `tm-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Other Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "owner-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  return {
    restaurantId: restaurant.id,
    locationId: location.id,
    categoryId: category.id,
    otherLocationId: otherLocation.id,
    otherRestaurantId: otherRestaurant.id,
  };
}

async function createMenuItem(fixture: Fixture, name: string, price = "800.00") {
  return prisma.menuItem.create({
    data: {
      restaurantId: fixture.restaurantId,
      categoryId: fixture.categoryId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`,
      price,
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
}

async function newTable(fixture: Fixture) {
  const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: `Floor-${randomUUID()}` } });
  return prisma.restaurantTable.create({ data: { floorId: floor.id, label: `T-${randomUUID().slice(0, 6)}` } });
}

async function orderAndPay(ctx: AuthContext, fixture: Fixture, menuItemId: string, quantity: number) {
  const table = await newTable(fixture);
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(ctx, submitted.id, { method: "CASH" });
}

async function seedIngredient(
  ctx: AuthContext,
  fixture: Fixture,
  name: string,
  unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "PIECE",
  initialStock: number
) {
  const ingredient = await ingredients.createIngredient(ctx, { name, unit });
  await ingredients.initializeStock(ctx, { ingredientId: ingredient.id, locationId: fixture.locationId, initialStock });
  return ingredient;
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("NO_TRACKING: nema odbitka ni jednog ni drugog tipa", () => {
  it("naplata artikla u NO_TRACKING modu ne stvara InventoryMovement niti IngredientMovement", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Kafa (bez praćenja)");
    expect(item.inventoryTrackingMethod).toBe("NO_TRACKING"); // default

    const result = await orderAndPay(owner, fixture, item.id, 3);
    expect(result.payment.id).toBeTruthy();

    const invMov = await prisma.inventoryMovement.findMany({ where: { menuItemId: item.id } });
    const ingMov = await prisma.ingredientMovement.findMany({ where: { restaurantId: fixture.restaurantId, orderId: result.order.id } });
    expect(invMov).toHaveLength(0);
    expect(ingMov).toHaveLength(0);
  });

  it("NO_TRACKING artikal se nikad ne blokira zbog zaliha, čak i sa 'osirotelim' InventoryItem redom na 0", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal");
    // Osiroteo InventoryItem red (npr. posle ANY -> NO_TRACKING) na 0 -- ne sme uticati.
    await prisma.inventoryItem.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, menuItemId: item.id, currentStock: 0, unit: "kom" },
    });
    await expect(orderAndPay(owner, fixture, item.id, 5)).resolves.toMatchObject({ payment: { } });
  });
});

describe("DIRECT_STOCK: gotov proizvod, isto ponašanje kao staro trackStock", () => {
  it("Ordever 50 -> 48 posle prodaje 2 komada, bez ijednog IngredientMovement", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Ordever");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 50, unit: "kom" });
    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(mi.inventoryTrackingMethod).toBe("DIRECT_STOCK");

    const result = await orderAndPay(owner, fixture, item.id, 2);

    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(after.currentStock)).toBe(48);
    const ingMov = await prisma.ingredientMovement.findMany({ where: { restaurantId: fixture.restaurantId, orderId: result.order.id } });
    expect(ingMov).toHaveLength(0);
  });
});

describe("RECIPE: normativ od sirovina, tačan odbitak po receptu", () => {
  it("Punjena pljeskavica x2 tačno oduzima 0.600kg mesa i 0.300kg kačkavalja, bez InventoryItem odbitka", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Punjena pljeskavica");
    const meso = await seedIngredient(owner, fixture, "Roštilj meso", "KILOGRAM", 10);
    const kackavalj = await seedIngredient(owner, fixture, "Kačkavalj", "KILOGRAM", 5);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meso.id, quantity: 0.3 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: kackavalj.id, quantity: 0.15 });

    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(mi.inventoryTrackingMethod).toBe("RECIPE");

    const result = await orderAndPay(owner, fixture, item.id, 2);

    const mesoStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meso.id, locationId: fixture.locationId } });
    const kackaljStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: kackavalj.id, locationId: fixture.locationId } });
    expect(Number(mesoStock.currentStock)).toBeCloseTo(10 - 0.6, 9);
    expect(Number(kackaljStock.currentStock)).toBeCloseTo(5 - 0.3, 9);

    const invMov = await prisma.inventoryMovement.findMany({ where: { menuItemId: item.id, orderId: result.order.id } });
    expect(invMov).toHaveLength(0);
  });

  it("RECIPE artikal sa 0 linija ('Normativ nije podešen') blokira dodavanje u porudžbinu", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Nepodešen normativ");
    await inventory.setInventoryTrackingMethod(owner, item.id, "RECIPE"); // dozvoljeno da se sačuva "nedovršeno"

    const table = await newTable(fixture);
    const order = await orders.openOrder(owner, { tableId: table.id });
    await expect(orders.addItem(owner, order.id, { menuItemId: item.id, quantity: 1 })).rejects.toBeInstanceOf(
      ingredients.RecipeNotConfiguredError
    );
  });

  it("RECIPE artikal sa 0 linija blokira i samu naplatu (rollback, bez mutacije)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Nepodešen normativ 2");
    await inventory.setInventoryTrackingMethod(owner, item.id, "RECIPE");

    await expect(
      ingredients.decrementIngredientsOnSale({
        paymentId: randomUUID(),
        orderId: randomUUID(),
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationId,
        items: [{ menuItemId: item.id, quantity: 1 }],
      })
    ).rejects.toBeInstanceOf(ingredients.RecipeNotConfiguredError);
  });
});

describe("Struktuurna garancija: RECIPE artikal nikad ne dobija I direct-stock odbitak za isti payment", () => {
  it("legacy/nesinhronizovano trackStock=true uz method=RECIPE ne uzrokuje dupli odbitak — samo IngredientMovement nastaje", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Dual-model artikal");
    await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 20 });
    const meso = await seedIngredient(owner, fixture, "Meso", "KILOGRAM", 5);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meso.id, quantity: 0.2 }); // auto-promoveno na RECIPE, trackStock -> false

    // Simulira zastarelo/pokvareno stanje (npr. neko ručno vratio trackStock
    // bez menjanja inventoryTrackingMethod) — enum MORA i dalje pobediti.
    await prisma.menuItem.update({ where: { id: item.id }, data: { trackStock: true } });

    const result = await orderAndPay(owner, fixture, item.id, 1);

    const invMov = await prisma.inventoryMovement.findMany({ where: { menuItemId: item.id, orderId: result.order.id } });
    const ingMov = await prisma.ingredientMovement.findMany({ where: { restaurantId: fixture.restaurantId, orderId: result.order.id } });
    expect(invMov).toHaveLength(0); // NIKAD dupli odbitak
    expect(ingMov).toHaveLength(1);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: item.id } });
    expect(Number(invItem.currentStock)).toBe(20); // netaknuto
  });
});

describe("Prelazak metode: istorija se NIKAD ne briše, bez obzira na pravac", () => {
  it("DIRECT_STOCK -> RECIPE (preko addRecipeLine): stari InventoryItem/InventoryMovement ostaju", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal A");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 25 });
    const meat = await seedIngredient(owner, fixture, "Meso A", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const stillThere = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(stillThere.currentStock)).toBe(25);
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: invItem.id } });
    expect(movements.length).toBeGreaterThan(0);
  });

  it("RECIPE -> DIRECT_STOCK (setInventoryTrackingMethod eksplicitno): IngredientMovement istorija ostaje", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal B");
    const meat = await seedIngredient(owner, fixture, "Meso B", "KILOGRAM", 10);
    const line = await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    await orderAndPay(owner, fixture, item.id, 3); // stvara SALE IngredientMovement istoriju

    const before = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id } });
    expect(before).toBeGreaterThan(0);

    await inventory.setInventoryTrackingMethod(owner, item.id, "DIRECT_STOCK");

    const after = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id } });
    expect(after).toBe(before); // ništa obrisano
    const lineStillThere = await prisma.menuItemIngredient.findUnique({ where: { id: line.id } });
    expect(lineStillThere).not.toBeNull(); // receptura se ne briše prelaskom metode

    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(mi.inventoryTrackingMethod).toBe("DIRECT_STOCK");
    expect(mi.trackStock).toBe(true); // legacy mirror sinhronizovan
  });

  it("RECIPE -> DIRECT_STOCK sa ZASTARELIM neisptažnjenim InventoryItem redom: zahteva potvrdu (StaleDirectStockQuantityError), pa NULIRA zalihu (nikad tiho ne veruje starom broju)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal B2");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 15 });
    const meat = await seedIngredient(owner, fixture, "Meso B2", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 }); // auto-promoveno na RECIPE; stari InventoryItem red (15) ostaje netaknut

    await expect(inventory.setInventoryTrackingMethod(owner, item.id, "DIRECT_STOCK")).rejects.toBeInstanceOf(
      inventory.StaleDirectStockQuantityError
    );
    let unchanged = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.inventoryTrackingMethod).toBe("RECIPE"); // odbijen pokušaj ne menja ništa
    let stillStale = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(stillStale.currentStock)).toBe(15);

    await inventory.setInventoryTrackingMethod(owner, item.id, "DIRECT_STOCK", { confirmReactivateDirectStock: true });

    const confirmed = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(confirmed.inventoryTrackingMethod).toBe("DIRECT_STOCK");
    // Potvrda NIKAD tiho ne veruje starom broju — nulira ga (auditovano),
    // artikal je DIRECT_STOCK ali OUT dok menadžer ne unese stvarno stanje.
    const zeroed = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(zeroed.currentStock)).toBe(0);
    const zeroingMovement = await prisma.inventoryMovement.findFirst({
      where: { inventoryItemId: invItem.id, type: "ADJUSTMENT", quantityAfter: 0 },
      orderBy: { createdAt: "desc" },
    });
    expect(zeroingMovement).not.toBeNull();
    expect(Number(zeroingMovement?.quantityBefore)).toBe(15);
  });

  it("initializeTracking pozvan PONOVO na već postojeći red REKONCILIŠE na uneti broj (nikad tiho ne odbacuje unos), auditovano", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal B3");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 10 });

    const reInit = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 4 });
    expect(reInit.id).toBe(invItem.id); // isti red, ne duplikat
    expect(Number(reInit.currentStock)).toBe(4); // uneti broj se PRIMENJUJE, ne odbacuje

    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: invItem.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.type)).toEqual(["INITIAL", "OPENING_STOCK"]);
    expect(Number(movements[1].quantityBefore)).toBe(10);
    expect(Number(movements[1].quantityAfter)).toBe(4);
  });

  it("DIRECT_STOCK -> NO_TRACKING sa preostalom zalihom: zahteva potvrdu (DirectStockStillPresentError), pa uspeva uz confirm", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal C");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 7 });

    await expect(inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING")).rejects.toBeInstanceOf(
      inventory.DirectStockStillPresentError
    );

    // Ništa se nije promenilo posle odbijenog pokušaja.
    const stillDirect = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stillDirect.inventoryTrackingMethod).toBe("DIRECT_STOCK");

    await inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING", { confirmSwitchAwayFromDirectStock: true });

    const updated = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.inventoryTrackingMethod).toBe("NO_TRACKING");
    expect(updated.trackStock).toBe(false);

    // Stara zaliha i istorija ostaju netaknute -- samo se prestaju koristiti.
    const stockRow = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(stockRow.currentStock)).toBe(7);
  });

  it("switch away from DIRECT_STOCK sa 0 preostale zalihe ne traži potvrdu", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal D");
    await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 0 });

    await expect(inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING")).resolves.toMatchObject({
      inventoryTrackingMethod: "NO_TRACKING",
    });
  });

  it("ANY -> NO_TRACKING: buduće prodaje prestaju da odbijaju, stare IngredientMovement ostaju", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal E");
    const meat = await seedIngredient(owner, fixture, "Meso E", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    await orderAndPay(owner, fixture, item.id, 1);

    const historyBefore = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id } });

    await inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING");
    const result = await orderAndPay(owner, fixture, item.id, 1);

    const historyAfter = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id } });
    expect(historyAfter).toBe(historyBefore); // nova prodaja NE dodaje SALE kretanje
    const ingMovForThisOrder = await prisma.ingredientMovement.findMany({ where: { orderId: result.order.id } });
    expect(ingMovForThisOrder).toHaveLength(0);
  });

  it("initializeTracking odbija RECIPE-mod artikal (mora se prvo promeniti metoda)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Artikal F");
    const meat = await seedIngredient(owner, fixture, "Meso F", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.1 });

    await expect(
      inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 10 })
    ).rejects.toThrow(/normativ/i);
  });
});

describe("Dostupnost po metodi (nezavisno testirano)", () => {
  it("RECIPE dostupnost: 0.3kg/porcija normativ, 1.2kg zaliha -> najviše 4 porcije, uz shared-ingredient agregaciju", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Recept dostupnost");
    const ing = await seedIngredient(owner, fixture, "Sirovina X", "KILOGRAM", 1.2);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: ing.id, quantity: 0.3 });

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.status).toBe("AVAILABLE");
    expect(info?.availablePortions).toBe(4);
    expect(info?.configured).toBe(true);
  });

  it("RECIPE dostupnost: 0 linija -> OUT sa configured=false ('Normativ nije podešen')", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Bez normativa");
    await inventory.setInventoryTrackingMethod(owner, item.id, "RECIPE");

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.status).toBe("OUT");
    expect(info?.configured).toBe(false);
  });

  it("audit §6/§12: sirovina POSTOJI kao Ingredient ali NEMA IngredientStock red za ovu lokaciju -> tretira se kao 0 dostupno (NIKAD 'neograničeno') za PRIKAZ, ali naplata NIKAD ne blokira — red se atomično kreira na 0 i ide u negativno", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Šopska (bez inicijalizovane zalihe)");
    // Sirovina kreirana, ali initializeStock NIKAD pozvan za ovu lokaciju -- nema IngredientStock reda uopšte (različito od "postoji red sa 0").
    const tomato = await ingredients.createIngredient(owner, { name: "Paradajz bez zalihe", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: tomato.id, quantity: 0.3 });

    const stockRow = await prisma.ingredientStock.findFirst({ where: { ingredientId: tomato.id, locationId: fixture.locationId } });
    expect(stockRow).toBeNull(); // zaista nema reda, ne samo 0

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.status).toBe("OUT"); // NIKAD "neograničeno dostupno"
    expect(info?.configured).toBe(true); // normativ JESTE podešen -- razlog je zaliha, ne konfiguracija
    expect(info?.availablePortions).toBe(0);
    expect(info?.sellAllowed).toBe(true); // P1.7: OUT prikaz i dalje NE blokira prodaju

    // P1.7 audit §12: naplata NIKAD ne blokira zbog nedostajućeg reda —
    // atomično se kreira na 0, pa odbija (rezultat je negativan).
    await ingredients.decrementIngredientsOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: item.id, quantity: 1 }],
    });

    const createdStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: tomato.id, locationId: fixture.locationId } });
    expect(Number(createdStock.currentStock)).toBeCloseTo(-0.3, 9);
    const movement = await prisma.ingredientMovement.findFirstOrThrow({ where: { ingredientId: tomato.id, type: "SALE" } });
    expect(Number(movement.quantityBefore)).toBe(0);
    expect(Number(movement.quantityAfter)).toBeCloseTo(-0.3, 9);
  });

  it("NO_TRACKING artikal se nikad ne pojavljuje kao 'OUT' zbog zaliha — inventar ga nikad ne blokira", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Slobodan artikal");

    const stockStatus = await inventory.getStockStatusForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const recipeAvailability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    expect(stockStatus.get(item.id)?.trackingEnabled).toBe(false);
    expect(recipeAvailability.has(item.id)).toBe(false); // odsutan iz mape = "nije recepturisan"
  });

  it("audit §25 (scenario H): sirovina dostupna na Lokaciji A NE čini artikal dostupnim na Lokaciji B", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Šopska (dve lokacije)");
    const tomato = await ingredients.createIngredient(owner, { name: "Paradajz dve lokacije", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: tomato.id, quantity: 0.3 });
    // Zaliha postoji SAMO na glavnoj lokaciji (A) -- ne i na "Other" (B).
    await ingredients.initializeStock(owner, { ingredientId: tomato.id, locationId: fixture.locationId, initialStock: 10 });

    const atA = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    expect(atA.get(item.id)?.status).toBe("AVAILABLE");

    const atB = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.otherLocationId, [item.id]);
    expect(atB.get(item.id)?.status).toBe("OUT"); // zaliha sa A se NIKAD ne "pozajmljuje" na B
    expect(atB.get(item.id)?.availablePortions).toBe(0);

    // P1.7: naplata na lokaciji B NIKAD ne blokira, ali NIKAD ne "pozajmljuje"
    // zalihu sa A — B-ov IngredientStock red se kreira nezavisno i ide negativno.
    await ingredients.decrementIngredientsOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.otherLocationId,
      items: [{ menuItemId: item.id, quantity: 1 }],
    });

    const stockB = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: tomato.id, locationId: fixture.otherLocationId } });
    expect(Number(stockB.currentStock)).toBeCloseTo(-0.3, 9);

    // Zaliha na A ostaje POTPUNO netaknuta.
    const stockA = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: tomato.id, locationId: fixture.locationId } });
    expect(Number(stockA.currentStock)).toBe(10);
  });
});

describe("audit §32: cross-restaurant izolacija za nove P1.6 funkcije", () => {
  it("setInventoryTrackingMethod odbija menuItemId koji pripada DRUGOM restoranu", async () => {
    const fixture = await createFixture();
    const foreignOwner: AuthContext = {
      userId: "foreign-owner",
      employeeId: "foreign-owner",
      restaurantId: fixture.otherRestaurantId,
      locationIds: [],
      roles: ["OWNER"],
      permissions: new Set(["inventory.manage", "menu.view", "menu.manage"]),
    };
    const item = await createMenuItem(fixture, "Tuđi artikal");

    await expect(inventory.setInventoryTrackingMethod(foreignOwner, item.id, "DIRECT_STOCK")).rejects.toThrow(/nije pronađen/i);

    const unchanged = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.inventoryTrackingMethod).toBe("NO_TRACKING");
  });

  it("getRecipeAvailabilityForMenuItems se ne curi preko restaurantId granice — druga restoran-scoped sirovina ne utiče", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const foreignLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Foreign" } });
    const foreignOwner: AuthContext = {
      userId: "foreign-owner-2",
      employeeId: "foreign-owner-2",
      restaurantId: fixture.otherRestaurantId,
      locationIds: [foreignLocation.id],
      roles: ["OWNER"],
      permissions: new Set(["inventory.manage", "inventory.view", "menu.view", "menu.manage"]),
    };

    const item = await createMenuItem(fixture, "Restoran A artikal");
    const tomato = await ingredients.createIngredient(owner, { name: "Paradajz A", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: tomato.id, quantity: 0.3 });
    await ingredients.initializeStock(owner, { ingredientId: tomato.id, locationId: fixture.locationId, initialStock: 10 });

    // Isti naziv sirovine u DRUGOM restoranu, sa velikom zalihom -- ne sme uticati.
    const foreignTomato = await ingredients.createIngredient(foreignOwner, { name: "Paradajz A", unit: "KILOGRAM" });
    await ingredients.initializeStock(foreignOwner, { ingredientId: foreignTomato.id, locationId: foreignLocation.id, initialStock: 999 });

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    expect(availability.get(item.id)?.status).toBe("AVAILABLE");
    expect(availability.get(item.id)?.availablePortions).toBe(Math.floor(10 / 0.3));
  });
});

describe("RBAC: samo OWNER/ADMIN/MANAGER menjaju metodu praćenja", () => {
  it("WAITER ne može da promeni inventoryTrackingMethod", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const waiter = waiterCtx(fixture);
    const item = await createMenuItem(fixture, "RBAC artikal");

    await expect(inventory.setInventoryTrackingMethod(waiter, item.id, "DIRECT_STOCK")).rejects.toBeInstanceOf(ForbiddenError);

    const unchanged = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.inventoryTrackingMethod).toBe("NO_TRACKING");
    void owner;
  });

  it("audituje promenu metode praćenja sa prethodnom i novom vrednošću", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Audit artikal");

    await inventory.setInventoryTrackingMethod(owner, item.id, "DIRECT_STOCK");

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: "MenuItem", entityId: item.id, action: "menu_item.inventory_tracking_method_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toBeTruthy();
    expect(entry?.newValue).toMatchObject({ inventoryTrackingMethod: "DIRECT_STOCK" });
    expect(entry?.previousValue).toMatchObject({ inventoryTrackingMethod: "NO_TRACKING" });
  });

  it("no-op: postavljanje već aktivne metode ne menja ništa niti audituje", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "No-op artikal");

    await inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING");
    const auditCountBefore = await prisma.auditLog.count({ where: { entityType: "MenuItem", entityId: item.id } });
    const result = await inventory.setInventoryTrackingMethod(owner, item.id, "NO_TRACKING");
    const auditCountAfter = await prisma.auditLog.count({ where: { entityType: "MenuItem", entityId: item.id } });

    expect(result.inventoryTrackingMethod).toBe("NO_TRACKING");
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
