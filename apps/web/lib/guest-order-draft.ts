"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * P0 GUEST QR ORDERING — the guest's local, pre-finalize draft. PURELY
 * client-side (localStorage) until the guest taps "ZAVRŠI PORUDŽBINU" —
 * this module never makes a network call. Scoped by restaurant slug so a
 * guest who scans a DIFFERENT restaurant's QR (or navigates directly to
 * another /m/[slug]) never sees a stale draft bleed across tenants.
 *
 * name/price/preparationStation are stored here for display only — the
 * server re-reads all of this from MenuItem at finalize and never trusts
 * this snapshot (see guest-order-service.ts finalizeGuestOrder).
 */
export interface GuestDraftItem {
  menuItemId: string;
  name: string;
  price: string;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
  quantity: number;
  note: string;
}

const MAX_NOTE_LENGTH = 140;
const MAX_QUANTITY = 20;

function storageKey(slug: string): string {
  return `tablecore:guest-draft:${slug}`;
}

function readDraft(slug: string): GuestDraftItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is GuestDraftItem =>
        i && typeof i.menuItemId === "string" && typeof i.name === "string" && typeof i.price === "string" && typeof i.quantity === "number" && typeof i.note === "string"
    );
  } catch {
    return [];
  }
}

export function useGuestOrderDraft(slug: string) {
  // Starts empty on EVERY render pass, server or client — never reads
  // localStorage in the initializer. The server can never see localStorage
  // at all (always []), so a client first-render that read a real,
  // non-empty draft here would permanently diverge from the server HTML —
  // a genuine hydration mismatch (proven via browser console: "Text
  // content did not match... + Kreiraj porudžbinu / + Dodaj još stavki"),
  // which forces React to discard and re-render the ENTIRE root client-side
  // instead of just this component. The effect below (already existing,
  // runs after every mount) hydrates the real draft one tick later — a
  // normal post-mount state update, not a hydration error.
  const [items, setItems] = useState<GuestDraftItem[]>([]);
  // Real state, NOT a ref — a ref mutated inside the hydrate effect below
  // would already read as true by the time the persist effect's OWN stale
  // (pre-hydration) closure runs in the same mount flush, defeating the
  // guard. State correctly keeps `false` tied to the pre-hydration render
  // and only flips for the render that actually has the real items.
  const [hydrated, setHydrated] = useState(false);

  // Refresh from storage if `slug` itself changes at runtime (shouldn't
  // normally happen within one page view, but keeps the hook correct if it
  // ever does) — never merges across slugs. Also serves as the initial
  // client-only hydration from localStorage (see comment above).
  useEffect(() => { setItems(readDraft(slug)); setHydrated(true); }, [slug]);

  useEffect(() => {
    // Guest QR physical QA regression — without this guard, THIS effect and
    // the hydrate effect above both run on the same initial-mount flush,
    // in declaration order. On that first pass `items` is still `[]` (the
    // hydrate effect's setItems(readDraft(slug)) only SCHEDULES the real
    // value, it doesn't apply synchronously), so this effect saw an empty
    // cart and called removeItem — permanently wiping a real, non-empty
    // draft from storage before the hydrate effect's own value ever
    // reached the DOM. Skipping until hydration has actually landed (a
    // render where `hydrated` itself is true) closes that window.
    if (typeof window === "undefined" || !hydrated) return;
    try {
      if (items.length === 0) window.localStorage.removeItem(storageKey(slug));
      else window.localStorage.setItem(storageKey(slug), JSON.stringify(items));
    } catch {
      // localStorage unavailable (private mode, quota) — draft stays in-memory only for this session.
    }
  }, [slug, items, hydrated]);

  const addItem = useCallback((menuItem: { id: string; name: string; price: string; preparationStation: GuestDraftItem["preparationStation"] }) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.menuItemId === menuItem.id && i.note === "");
      if (existing) {
        return prev.map((i) => (i === existing ? { ...i, quantity: Math.min(MAX_QUANTITY, i.quantity + 1) } : i));
      }
      return [...prev, { menuItemId: menuItem.id, name: menuItem.name, price: menuItem.price, preparationStation: menuItem.preparationStation, quantity: 1, note: "" }];
    });
  }, []);

  // Final UX pass — was setQuantity(id, index, absoluteTarget), with the
  // Stepper's +/- buttons computing that target from their OWN `value`
  // prop (value - 1 / value + 1). Several rapid taps landing before React
  // re-renders all read the SAME stale `value`, so they all computed the
  // SAME target — one decrement registered no matter how many taps
  // actually happened. A relative delta resolved INSIDE the functional
  // setItems updater is safe under rapid taps by construction: React
  // guarantees each queued functional update receives the previous one's
  // OUTPUT, never a stale snapshot, so N taps always apply N decrements.
  const changeQuantity = useCallback((menuItemId: string, index: number, delta: number) => {
    setItems((prev) => {
      const current = prev[index];
      // Guard, not just optimization: if an earlier queued update in this
      // same batch already removed this line, `index` may now point at a
      // DIFFERENT item that slid into its place — never decrement that one.
      if (current?.menuItemId !== menuItemId) return prev;
      const next = current.quantity + delta;
      if (next <= 0) return prev.filter((_, i) => i !== index);
      return prev.map((item, i) => (i === index ? { ...item, quantity: Math.min(MAX_QUANTITY, next) } : item));
    });
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const setNote = useCallback((index: number, note: string) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, note: note.slice(0, MAX_NOTE_LENGTH) } : item)));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const itemCount = useMemo(() => items.reduce((sum, i) => sum + i.quantity, 0), [items]);
  const totalPrice = useMemo(() => items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0), [items]);

  return { items, addItem, changeQuantity, removeItem, setNote, clear, itemCount, totalPrice, maxNoteLength: MAX_NOTE_LENGTH, maxQuantity: MAX_QUANTITY };
}
