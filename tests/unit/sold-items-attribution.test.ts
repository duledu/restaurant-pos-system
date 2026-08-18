import { describe, it, expect } from "vitest";
import { reporting } from "@rcs/domain";
import type { RawSoldItem, SoldItemsStationFilter } from "@rcs/domain/reporting/reporting-service";

function item(
  name: string,
  preparationStation: string,
  price: string,
  quantity: number,
  category?: string
): RawSoldItem {
  return {
    name,
    price,
    quantity,
    preparationStation,
    menuItem: category ? { category: { name: category } } : null,
  };
}

function agg(items: RawSoldItem[], station: SoldItemsStationFilter = "ALL") {
  return reporting.aggregateSoldItems(items, station);
}

describe("aggregateSoldItems — KITCHEN_AND_BAR pravilo (bez duplog brojanja)", () => {
  it("KITCHEN_AND_BAR ide ISKLJUCIVO u kitchenRevenue, NE u barRevenue", () => {
    const { summary } = agg([item("Burger", "KITCHEN_AND_BAR", "1000", 1)]);
    expect(summary.kitchenRevenue).toBe("1000");
    expect(summary.barRevenue).toBe("0");
    expect(summary.allRevenue).toBe("1000");
  });

  it("KITCHEN ide u kitchenRevenue", () => {
    const { summary } = agg([item("Supa", "KITCHEN", "500", 2)]);
    expect(summary.kitchenRevenue).toBe("1000");
    expect(summary.barRevenue).toBe("0");
    expect(summary.allRevenue).toBe("1000");
  });

  it("BAR ide u barRevenue", () => {
    const { summary } = agg([item("Pivo", "BAR", "300", 3)]);
    expect(summary.kitchenRevenue).toBe("0");
    expect(summary.barRevenue).toBe("900");
    expect(summary.allRevenue).toBe("900");
  });

  it("NONE ne ide ni u kitchen ni u bar, ali jeste u allRevenue", () => {
    const { summary } = agg([item("Napitak", "NONE", "200", 1)]);
    expect(summary.kitchenRevenue).toBe("0");
    expect(summary.barRevenue).toBe("0");
    expect(summary.allRevenue).toBe("200");
  });

  it("mesovita porudzbina: KITCHEN_AND_BAR + BAR, allRevenue = kitchenRevenue + barRevenue (nema duplog)", () => {
    const items = [
      item("Burger", "KITCHEN_AND_BAR", "1000", 1),
      item("Pivo", "BAR", "300", 2),
    ];
    const { summary } = agg(items);
    const kit = parseFloat(summary.kitchenRevenue);
    const bar = parseFloat(summary.barRevenue);
    const all = parseFloat(summary.allRevenue);
    expect(kit).toBe(1000);
    expect(bar).toBe(600);
    expect(all).toBe(kit + bar);
  });

  it("kolicine se ispravno sabiraju", () => {
    const items = [
      item("Burger", "KITCHEN_AND_BAR", "1000", 2),
      item("Pivo", "BAR", "300", 3),
    ];
    const { summary } = agg(items);
    expect(summary.kitchenQuantity).toBe(2);
    expect(summary.barQuantity).toBe(3);
    expect(summary.allQuantity).toBe(5);
  });
});

describe("aggregateSoldItems — grupisanje po imenu i stanici", () => {
  it("isti artikal, ista stanica → jedan red sa zbirnim kolicinama i prihodom", () => {
    const items = [
      item("Burger", "KITCHEN", "1000", 1),
      item("Burger", "KITCHEN", "1000", 2),
    ];
    const { rows } = agg(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalQuantity).toBe(3);
    expect(rows[0].totalRevenue).toBe("3000");
  });

  it("isti artikal, razlicita stanica → dva odvojena reda", () => {
    const items = [
      item("Voda", "KITCHEN", "150", 1),
      item("Voda", "BAR", "150", 1),
    ];
    const { rows } = agg(items);
    expect(rows).toHaveLength(2);
  });

  it("prosecna cena = prihod / kolicina", () => {
    const items = [
      item("Burger", "KITCHEN", "1000", 1),
      item("Burger", "KITCHEN", "1200", 1),
    ];
    const { rows } = agg(items);
    expect(rows[0].totalQuantity).toBe(2);
    expect(rows[0].totalRevenue).toBe("2200");
    expect(parseFloat(rows[0].avgPrice)).toBe(1100);
  });

  it("categoryName se prenosi iz menuItem", () => {
    const { rows } = agg([item("Burger", "KITCHEN", "1000", 1, "Hrana")]);
    expect(rows[0].categoryName).toBe("Hrana");
  });

  it("menuItem = null → categoryName = null", () => {
    const { rows } = agg([item("Burger", "KITCHEN", "1000", 1)]);
    expect(rows[0].categoryName).toBeNull();
  });
});

describe("aggregateSoldItems — filtriranje po stanici", () => {
  const mixed = [
    item("A", "KITCHEN", "100", 1),
    item("B", "BAR", "200", 1),
    item("C", "KITCHEN_AND_BAR", "300", 1),
    item("D", "NONE", "400", 1),
  ];

  it("station=ALL vraca sve redove", () => {
    const { rows } = agg(mixed, "ALL");
    expect(rows).toHaveLength(4);
  });

  it("station=KITCHEN vraca KITCHEN i KITCHEN_AND_BAR, ne BAR ni NONE", () => {
    const { rows } = agg(mixed, "KITCHEN");
    const stations = rows.map((r) => r.station);
    expect(stations).toContain("KITCHEN");
    expect(stations).toContain("KITCHEN_AND_BAR");
    expect(stations).not.toContain("BAR");
    expect(stations).not.toContain("NONE");
  });

  it("station=BAR vraca samo BAR redove", () => {
    const { rows } = agg(mixed, "BAR");
    expect(rows).toHaveLength(1);
    expect(rows[0].station).toBe("BAR");
  });

  it("station filter ne menja summary — summary uvek sadrzi sve stavke", () => {
    const { summary: allSummary } = agg(mixed, "ALL");
    const { summary: kitSummary } = agg(mixed, "KITCHEN");
    const { summary: barSummary } = agg(mixed, "BAR");
    expect(allSummary.allRevenue).toBe(kitSummary.allRevenue);
    expect(allSummary.allRevenue).toBe(barSummary.allRevenue);
    expect(allSummary.allQuantity).toBe(kitSummary.allQuantity);
  });
});

describe("aggregateSoldItems — ivicni slucajevi", () => {
  it("prazna lista vraca nule", () => {
    const { rows, summary } = agg([]);
    expect(rows).toHaveLength(0);
    expect(summary.allRevenue).toBe("0");
    expect(summary.kitchenRevenue).toBe("0");
    expect(summary.barRevenue).toBe("0");
    expect(summary.allQuantity).toBe(0);
  });

  it("decimalni prihod se tacno sabira bez gubitka preciznosti", () => {
    const items = [
      item("Item", "KITCHEN", "33.33", 3),
    ];
    const { summary } = agg(items);
    expect(summary.kitchenRevenue).toBe("99.99");
    expect(summary.allRevenue).toBe("99.99");
  });
});
