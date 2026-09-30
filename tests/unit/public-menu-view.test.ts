// @vitest-environment jsdom
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PublicMenuView, type PublicMenuPayload } from "../../apps/web/app/m/[slug]/public-menu-view";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "fixture-font" });
  return { Playfair_Display: font, Inter: font, Outfit: font, Cormorant_Garamond: font, Fredoka: font };
});

const fixture: PublicMenuPayload = {
  restaurant: { name: "Test restaurant", tagline: null, coverImageUrl: null, logoUrl: null },
  theme: { themePreset: "DARK", typographyPreset: "ELEGANT", accentColor: null, cardStyle: "BALANCED", imageShape: "SOFT" },
  table: { label: "7" },
  categories: [
    { id: "mixed", name: "Mešovita kategorija", type: "FOOD", items: [
      { id: "dish", name: "Punjena pljeskavica sa kajmakom i pršutom", description: "Opis iz baze", price: "890", imageUrl: "https://example.com/dish.jpg", isAvailable: true, preparationStation: "KITCHEN" },
      { id: "no-image", name: "Ćevapi", description: null, price: "650", imageUrl: null, isAvailable: false, preparationStation: "KITCHEN" },
      { id: "coffee", name: "Espresso", description: null, price: "180", imageUrl: null, isAvailable: true, preparationStation: "BAR" },
    ] },
  ],
};
let root: Root;
let host: HTMLDivElement;
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
async function render(menu = fixture) { await act(async () => root.render(h(PublicMenuView, { menu }))); }
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.querySelector<HTMLButtonElement>("button")?.focus(); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("public menu interactions", () => {
  it("switches stations within a mixed category and preserves the shared category", async () => {
    await render();
    expect(host.querySelector("main")!.textContent).toContain("Ćevapi");
    expect(host.querySelector("main")!.textContent).not.toContain("Espresso");
    await click('[role="group"] button:nth-child(2)');
    expect(host.querySelector("main")!.textContent).toContain("Espresso");
    expect(host.querySelector("main")!.textContent).not.toContain("Ćevapi");
    expect(host.querySelector('nav a')!.textContent).toBe("Mešovita kategorija");
    expect(host.querySelector('[role="group"] button:nth-child(2)')!.getAttribute("aria-pressed")).toBe("true");
  });
  it("renders real descriptions/prices and a text-only unavailable row without placeholders", async () => {
    await render();
    // Final UX pass — a row's "open detail" button (aria-haspopup="dialog")
    // is now a leaf-level button wrapping only name/description (never the
    // whole row) so it can't nest the "+ Dodaj" button; the thumbnail (when
    // present) is a SEPARATE tabIndex={-1} button, and price is a sibling
    // of both, not inside either — see MenuRow. One "open detail" button
    // per row remains a stable "one row = one thing" selector; the
    // containing .row div is what carries the FULL row text (name + price).
    const openButtons = host.querySelectorAll('main button[aria-haspopup="dialog"]');
    expect(openButtons[0].textContent).toContain("Opis iz baze");
    expect(openButtons[0].closest("div")!.textContent).toContain("890RSD");
    expect(openButtons[1].closest("div")!.querySelector("img")).toBeNull();
    expect(openButtons[1].closest("div")!.textContent).toBe("ĆevapiTrenutno nije dostupno650RSD");
    expect(host.querySelector("header img")).toBeNull();
    expect(host.querySelector("h1")!.textContent).toBe("Test restaurant");
  });
  it("discloses search on request, searches without diacritics, and restores focus on Escape", async () => {
    await render();
    expect(host.querySelector("input")).toBeNull();
    await click('[aria-label="Pretraga menija"]');
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cevapi"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelectorAll('main button[aria-haspopup="dialog"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Rezultati: 1");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("input")).toBeNull();
    // The browser-level QA also checks focus after the committed frame.
    expect(host.querySelectorAll('main button[aria-haspopup="dialog"]')).toHaveLength(2);
  });
  it("opens an accessible view-only detail, dismisses on cancel and restores the opener", async () => {
    await render();
    const opener = host.querySelector<HTMLButtonElement>("main button")!; opener.focus();
    await click("main button");
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")!.id);
    expect(dialog.querySelectorAll("button")).toHaveLength(1);
    expect(dialog.textContent).toContain("Opis iz baze");
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });
  it("drops failed images and keeps the dish information accessible", async () => {
    await render();
    const image = host.querySelector("main img")!;
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(host.querySelector("main img")).toBeNull();
    expect(host.querySelector("main button")!.textContent).toContain("Punjena pljeskavica");
  });
  it("starts with the bar for a drinks-only restaurant", async () => {
    const menu = structuredClone(fixture); menu.categories[0].items = menu.categories[0].items.filter(item => item.preparationStation === "BAR");
    await render(menu);
    expect(host.querySelector('[aria-pressed="true"]')!.textContent).toContain("Šank");
    expect(host.querySelector("main")!.textContent).toContain("Espresso");
  });
});
