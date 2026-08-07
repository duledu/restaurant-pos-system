import { describe, it, expect } from "vitest";
import {
  createCategorySchema,
  createMenuItemSchema,
  changePriceSchema,
} from "@rcs/shared";

describe("createCategorySchema", () => {
  it("prihvata validnu kategoriju", () => {
    const result = createCategorySchema.safeParse({ name: "Roštilj", slug: "rostilj", type: "FOOD", sortOrder: 0 });
    expect(result.success).toBe(true);
  });

  it("odbija slug sa velikim slovima ili razmacima", () => {
    const result = createCategorySchema.safeParse({ name: "Roštilj", slug: "Roštilj Meni", type: "FOOD" });
    expect(result.success).toBe(false);
  });

  it("odbija nepoznat type", () => {
    const result = createCategorySchema.safeParse({ name: "X", slug: "x", type: "DESSERT" });
    expect(result.success).toBe(false);
  });
});

describe("createMenuItemSchema", () => {
  it("prihvata minimalan validan artikal", () => {
    const result = createMenuItemSchema.safeParse({ name: "Ćevapi", slug: "cevapi", price: 650 });
    expect(result.success).toBe(true);
  });

  it("odbija negativnu cenu", () => {
    const result = createMenuItemSchema.safeParse({ name: "X", slug: "x", price: -10 });
    expect(result.success).toBe(false);
  });

  it("odbija nerealno veliku cenu (verovatna greška u unosu)", () => {
    const result = createMenuItemSchema.safeParse({ name: "X", slug: "x", price: 999_999_999 });
    expect(result.success).toBe(false);
  });

  it("dozvoljava needsReview stavku bez kategorije", () => {
    const result = createMenuItemSchema.safeParse({
      name: "Ramstek",
      slug: "ramstek",
      price: 0,
      needsReview: true,
      categoryId: null,
    });
    expect(result.success).toBe(true);
  });

  it("default preparationStation je NONE kada nije prosleđen", () => {
    const result = createMenuItemSchema.parse({ name: "X", slug: "x", price: 100 });
    expect(result.preparationStation).toBe("NONE");
  });
});

describe("changePriceSchema", () => {
  it("prihvata promenu cene sa razlogom", () => {
    const result = changePriceSchema.safeParse({ price: 750, reason: "Poskupljenje sirovina" });
    expect(result.success).toBe(true);
  });

  it("odbija negativnu cenu", () => {
    const result = changePriceSchema.safeParse({ price: -1 });
    expect(result.success).toBe(false);
  });
});
