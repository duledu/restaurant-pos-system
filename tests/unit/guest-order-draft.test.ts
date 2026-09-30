// @vitest-environment jsdom
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useGuestOrderDraft } from "../../apps/web/lib/guest-order-draft";

const STORAGE_KEY = "tablecore:guest-draft:masa";
const SEEDED_DRAFT = [
  { menuItemId: "a", name: "Pileća čorba", price: "200", preparationStation: "KITCHEN", quantity: 2, note: "Bez luka" },
  { menuItemId: "b", name: "Ordever", price: "600", preparationStation: "KITCHEN", quantity: 1, note: "" },
];

let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useGuestOrderDraft> | null = null;

function Harness({ slug }: { slug: string }) {
  latest = useGuestOrderDraft(slug);
  return null;
}
async function render(slug = "masa") { await act(async () => root.render(h(Harness, { slug }))); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  latest = null;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

// Physical QA regression (guest draft hydration/reload race) — a returning
// guest's browser already has a real, non-empty draft in localStorage when
// the page (re)mounts. useGuestOrderDraft must hydrate it WITHOUT ever
// wiping the stored copy in the process. The bug: the persist-to-storage
// effect and the hydrate-from-storage effect both run on the same initial
// mount flush, in declaration order; on that first pass `items` was still
// `[]` (hydrate's setItems only schedules the update), so persist saw an
// "empty" cart and called localStorage.removeItem — before hydrate's own
// value ever reached the DOM. Reproduced by seeding storage BEFORE mount,
// exactly like a real page load with an existing draft.
describe("useGuestOrderDraft — hydration must never wipe an existing draft", () => {
  it("a pre-existing non-empty draft survives mount intact, in both React state and localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SEEDED_DRAFT));
    await render();
    expect(latest!.items).toEqual(SEEDED_DRAFT);
    expect(latest!.itemCount).toBe(3); // 2 + 1
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(SEEDED_DRAFT);
  });

  it("an empty draft (truly no prior items) still starts and stays empty — hydration doesn't fabricate items", async () => {
    await render();
    expect(latest!.items).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("a genuinely-cleared draft (guest removes everything) DOES persist as removed, after hydration has landed", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SEEDED_DRAFT));
    await render();
    expect(latest!.items).toEqual(SEEDED_DRAFT); // hydrated first
    await act(async () => { latest!.clear(); });
    expect(latest!.items).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("changeQuantity resolves a delta against the LATEST state, not a stale snapshot (rapid-tap regression)", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SEEDED_DRAFT));
    await render();
    // Five queued +1 deltas in the same batch — must apply as 5 sequential
    // increments (2 -> 7), not 5 identical "stale value + 1" computations
    // collapsing into a single increment (the original Stepper bug).
    await act(async () => { for (let i = 0; i < 5; i++) latest!.changeQuantity("a", 0, 1); });
    expect(latest!.items[0].quantity).toBe(7);
  });

  it("changeQuantity below zero removes the line without going negative, even under rapid repeated calls", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SEEDED_DRAFT));
    await render();
    // "b" has quantity 1 — five -1 deltas must remove it once and then no-op
    // (never touch whatever slides into index 1 afterward), never negative.
    await act(async () => { for (let i = 0; i < 5; i++) latest!.changeQuantity("b", 1, -1); });
    expect(latest!.items).toEqual([SEEDED_DRAFT[0]]);
  });
});
