import { describe, expect, it } from "vitest";
import { filterMenuItems, matchesMenuSearch } from "../../apps/web/lib/menu-search";

const OMLET = { name: "Omlet", categoryId: "food" };
const OMLET_SIR = { name: "Omlet sa sirom", categoryId: "food" };
const VINJAK = { name: "Vinjak", categoryId: "drinks" };
const COLA = { name: "Coca-Cola", categoryId: "drinks" };

describe("matchesMenuSearch — case-insensitive name matching", () => {
  it.each(["Vinjak", "vinjak", "VINJAK", "VinJak"])("matches %s against a query of any case", (query) => {
    expect(matchesMenuSearch(VINJAK, query)).toBe(true);
  });

  it("matches a partial substring anywhere in the name", () => {
    expect(matchesMenuSearch(OMLET_SIR, "sir")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(matchesMenuSearch(COLA, "vinjak")).toBe(false);
  });

  it("ignores leading/trailing whitespace in the query", () => {
    expect(matchesMenuSearch(VINJAK, "  vinjak  ")).toBe(true);
  });
});

describe("filterMenuItems — search overrides category scoping (VIŠE-KRUŽNO NARUČIVANJE: 'Dodatna porudžbina' mora naći isti meni)", () => {
  const items = [OMLET, OMLET_SIR, VINJAK, COLA];

  it("with an empty search, scopes strictly to the active category", () => {
    expect(filterMenuItems(items, "", "drinks")).toEqual([VINJAK, COLA]);
    expect(filterMenuItems(items, "", "food")).toEqual([OMLET, OMLET_SIR]);
  });

  it("with a search query, searches across ALL categories regardless of the active tab", () => {
    // aktivna kartica je "food", ali Vinjak je u "drinks" — pretraga MORA
    // ipak da ga nađe bez ručnog menjanja kategorije (tačan bug iz izveštaja).
    expect(filterMenuItems(items, "Vinjak", "food")).toEqual([VINJAK]);
  });

  it("returns an empty array when nothing matches, never falls back to the whole category", () => {
    expect(filterMenuItems(items, "nepostojeci-artikal", "drinks")).toEqual([]);
  });

  it("with an active category of null and no search, returns nothing (nothing selected yet)", () => {
    expect(filterMenuItems(items, "", null)).toEqual([]);
  });
});
