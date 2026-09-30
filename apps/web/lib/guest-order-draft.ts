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
  const [items, setItems] = useState<GuestDraftItem[]>(() => readDraft(slug));

  // Refresh from storage if `slug` itself changes at runtime (shouldn't
  // normally happen within one page view, but keeps the hook correct if it
  // ever does) — never merges across slugs.
  useEffect(() => setItems(readDraft(slug)), [slug]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (items.length === 0) window.localStorage.removeItem(storageKey(slug));
      else window.localStorage.setItem(storageKey(slug), JSON.stringify(items));
    } catch {
      // localStorage unavailable (private mode, quota) — draft stays in-memory only for this session.
    }
  }, [slug, items]);

  const addItem = useCallback((menuItem: { id: string; name: string; price: string; preparationStation: GuestDraftItem["preparationStation"] }) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.menuItemId === menuItem.id && i.note === "");
      if (existing) {
        return prev.map((i) => (i === existing ? { ...i, quantity: Math.min(MAX_QUANTITY, i.quantity + 1) } : i));
      }
      return [...prev, { menuItemId: menuItem.id, name: menuItem.name, price: menuItem.price, preparationStation: menuItem.preparationStation, quantity: 1, note: "" }];
    });
  }, []);

  const setQuantity = useCallback((menuItemId: string, index: number, quantity: number) => {
    setItems((prev) => {
      if (quantity <= 0) return prev.filter((_, i) => !(i === index && prev[i].menuItemId === menuItemId));
      return prev.map((item, i) => (i === index && item.menuItemId === menuItemId ? { ...item, quantity: Math.min(MAX_QUANTITY, quantity) } : item));
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

  return { items, addItem, setQuantity, removeItem, setNote, clear, itemCount, totalPrice, maxNoteLength: MAX_NOTE_LENGTH, maxQuantity: MAX_QUANTITY };
}
