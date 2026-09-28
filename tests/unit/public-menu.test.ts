import { describe, expect, it } from "vitest";
import { editorialItemId, filterPublicMenu, publicImageSource } from "../../apps/web/lib/public-menu";
import type { PublicMenuCategory, PublicMenuItem } from "../../packages/domain/qrmenu/qr-menu-service";

const item = (id: string, preparationStation: PublicMenuItem["preparationStation"] = "KITCHEN"): PublicMenuItem => ({ id, name: id, description: null, price: "890", imageUrl: null, isAvailable: true, preparationStation });
const category = (items: PublicMenuItem[], type: PublicMenuCategory["type"] = "FOOD"): PublicMenuCategory => ({ id: "c", name: "Arbitrary restaurant category", type, items });

describe("public menu browsing", () => {
  it("uses item stations even when the category name and type suggest otherwise", () => {
    const categories = [category([item("Food", "KITCHEN"), item("Drink", "BAR")], "DRINK")];
    expect(filterPublicMenu(categories, "KITCHEN")[0].items.map(i => i.id)).toEqual(["Food"]);
    expect(filterPublicMenu(categories, "BAR")[0].items.map(i => i.id)).toEqual(["Drink"]);
  });
  it("keeps dual-station items in both modes and uses category type for NONE", () => {
    const categories = [category([item("Both", "KITCHEN_AND_BAR"), item("Unrouted", "NONE")], "DRINK")];
    expect(filterPublicMenu(categories, "KITCHEN")[0].items.map(i => i.id)).toEqual(["Both"]);
    expect(filterPublicMenu(categories, "BAR")[0].items.map(i => i.id)).toEqual(["Both", "Unrouted"]);
    expect(filterPublicMenu([category([item("Food", "NONE")])], "KITCHEN")[0].items).toHaveLength(1);
  });
  it("omits empty categories without losing unavailable items or changing order", () => {
    const unavailable = { ...item("unavailable"), isAvailable: false };
    const categories = [category([unavailable, item("second")])];
    expect(filterPublicMenu(categories, "BAR")).toEqual([]);
    expect(filterPublicMenu(categories, "KITCHEN")[0].items).toEqual([unavailable, item("second")]);
  });
  it("searches Serbian names/descriptions without requiring diacritics, within the current mode", () => {
    const categories = [category([{ ...item("x"), name: "Ćevapi", description: "Domaći roštilj" }, { ...item("y", "BAR"), name: "Ćevapi cocktail" }])];
    expect(filterPublicMenu(categories, "KITCHEN", " cevapi ")[0].items.map(i => i.id)).toEqual(["x"]);
    expect(filterPublicMenu(categories, "KITCHEN", "ROSTILJ")[0].items).toHaveLength(1);
    expect(filterPublicMenu(categories, "KITCHEN", "missing")).toEqual([]);
  });
  it("reserves the occasional editorial moment for an available photographed item after compact rows", () => {
    const items = [0, 1, 2, 3, 4].map(i => ({ ...item(String(i)), imageUrl: "https://example.com/food.jpg" }));
    items[3].isAvailable = false;
    expect(editorialItemId(category(items), 0)).toBe("4");
    expect(editorialItemId(category(items), 1)).toBeNull();
    expect(editorialItemId(category(items.slice(0, 2)), 0)).toBeNull();
    expect(items.map(i => i.id)).toEqual(["0", "1", "2", "3", "4"]);
  });
  it("rejects unsafe/broken image protocols while supporting existing browser image sources", () => {
    for (const source of [null, "", "javascript:alert(1)", "file:///image.png", "data:text/html,example", "//external.test/image"]) expect(publicImageSource(source)).toBeUndefined();
    for (const source of ["https://example.com/image.jpg", "http://example.com/image.jpg", "/images/dish.webp", "data:image/png;base64,aGVsbG8="]) expect(publicImageSource(source)).toBe(source);
  });
});
