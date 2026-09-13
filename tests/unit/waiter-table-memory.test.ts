import { describe, it, expect, vi } from "vitest";
import { tableMemory, resolveQuickSelection, quickSuggestions, repeatRound, createWaiterFavorites } from "../../apps/web/lib/waiter-table-memory";
import type { OrderItem } from "../../apps/web/lib/waiter-order-types";
import type { MenuItem } from "../../apps/web/lib/waiter-menu";
const menu: MenuItem = { id: "beer", name: "Pivo", price: "250", categoryId: null, modifierGroups: [], stock: null, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null, reasonLabel: null } };
const line: OrderItem = { id: "i", menuItemId: "beer", name: "Pivo", price: "100", quantity: 2, note: null, modifiers: [], status: "SERVED", submittedAt: "2026-09-13T10:00:00Z" };
describe("table memory", () => {
  it("derives history without drafts or cancellations", () => expect(tableMemory([line, { ...line, status: "DRAFT" }, { ...line, status: "CANCELLED" }]).recent).toMatchObject([{ quantity: 2 }]));
  it("ranks timestamp then quantity deterministically", () => {
    const lines = [line, { ...line, menuItemId: "water", quantity: 3 }];
    expect(tableMemory(lines).recent.map(x => x.menuItemId)).toEqual(["water", "beer"]);
    expect(tableMemory([...lines].reverse()).recent).toEqual(tableMemory(lines).recent);
  });
  it("uses latest exact item submittedAt across served and ready statuses", () => expect(tableMemory([line, { ...line, submittedAt: "2026-09-13T11:00:00Z", status: "READY" }]).lastRound).toMatchObject([{ status: "READY" }]));
  it("does not invent rounds for missing timestamps", () => expect(tableMemory([{ ...line, submittedAt: null }]).lastRound).toEqual([]));
  it.each([null, { isAvailable: false, reasonCode: null, reasonLabel: null }])("rejects unavailable or unknown overlay %j", availability => expect(resolveQuickSelection({ menuItemId: "beer", options: [] }, [{ ...menu, availability }])).toBeNull());
  it("uses current prepared price", () => expect(resolveQuickSelection(tableMemory([line]).recent[0], [menu])?.price).toBe("250"));
  it("keeps modifier identities separate and canonical", () => {
    const modifier = (id: string) => ({ id, modifierOptionId: id, groupName: "Extras", optionName: id, priceDelta: "0" });
    expect(tableMemory([line, { ...line, modifiers: [modifier("a"), modifier("b")] }, { ...line, modifiers: [modifier("b"), modifier("a")] }]).recent.map(x => x.quantity)).toEqual([4, 2]);
  });
  it("rejects deleted modifiers", () => expect(resolveQuickSelection({ menuItemId: "beer", options: ["gone"] }, [menu])).toBeNull());
  it("rejects newly required modifiers", () => expect(resolveQuickSelection({ menuItemId: "beer", options: [] }, [{ ...menu, modifierGroups: [{ group: { id: "g", name: "Size", isActive: true, required: true, minSelect: 1, maxSelect: 1, options: [] } }] }])).toBeNull());
  it("repeat reproduces quantity and modifier IDs", () => {
    const add = vi.fn(() => true);
    const option = { id: "lemon", name: "Lemon", priceDelta: "10", isActive: true };
    const drink = { ...menu, modifierGroups: [{ group: { id: "g", name: "Extras", isActive: true, required: false, minSelect: 0, maxSelect: 1, options: [option] } }] };
    repeatRound([{ ...line, modifiers: [{ id: "x", modifierOptionId: "lemon", groupName: "Extras", optionName: "Lemon", priceDelta: "0" }] }], [drink], add);
    expect(add.mock.calls).toEqual([["beer", ["lemon"]], ["beer", ["lemon"]]]);
  });
  it("partial repeat names unavailable items", () => {
    const add = vi.fn(() => true);
    const feedback = repeatRound([line, { ...line, menuItemId: "water", name: "Kisela", quantity: 1 }], [{ ...menu, id: "water" }], add);
    expect(add).toHaveBeenCalledTimes(1); expect(feedback).toContain("Ponovljeno: 1"); expect(feedback).toContain("Pivo");
  });
  it("reports quantity cap rejection", () => expect(repeatRound([line], [menu], () => false)).toContain("Pivo"));
  it("does not discard free-text instructions silently", () => { const add = vi.fn(() => true); expect(repeatRound([{ ...line, note: "bez leda" }], [menu], add)).toContain("Pivo"); expect(add).not.toHaveBeenCalled(); });
  it("table 12 has no table 5 memory", () => { tableMemory([line]); expect(tableMemory([]).recent).toEqual([]); });
  it("favorites increment and are separate by shell instance", () => { const a = createWaiterFavorites(), b = createWaiterFavorites(); a.record("beer", []); a.record("beer", []); expect(a.get()[0].quantity).toBe(2); expect(b.get()).toEqual([]); });
  it("clear destroys favorite scores", () => { const a = createWaiterFavorites(); a.record("beer", []); a.clear(); expect(a.get()).toEqual([]); });
  it("prioritizes table memory over favorites, deduplicates and caps at eight", () => {
    const recent = tableMemory([line]).recent;
    const favorites = Array.from({ length: 12 }, (_, i) => ({ ...recent[0], menuItemId: String(i) }));
    const result = quickSuggestions(recent, [...recent, ...favorites], [menu, ...favorites.map(x => ({ ...menu, id: x.menuItemId }))]);
    expect(result).toHaveLength(8); expect(result[0]).toMatchObject({ menuItemId: "beer", source: "table" });
  });
});
