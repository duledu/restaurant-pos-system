"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../components/ui/QuickLockButton";
import { VOID_REASON_CODES, VOID_REASON_LABELS, isMeaningfulVoidExplanation, type VoidReasonCode } from "@rcs/shared";
import { sameModifierSelection } from "../../../../lib/order-cart";
import { formatStockQty } from "../../../../lib/stock-format";

interface Category {
  id: string;
  name: string;
  type: "FOOD" | "DRINK";
}
interface ModifierOption {
  id: string;
  name: string;
  priceDelta: string;
  isActive: boolean;
}
interface ModifierGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: ModifierOption[];
}
interface MenuItemStock {
  trackingEnabled: boolean;
  currentStock: string | null;
  minimumStock: string | null;
  stockStatus: "OUT" | "LOW" | "OK" | null;
}
interface RecipeAvailability {
  status: "AVAILABLE" | "LOW" | "OUT";
  availablePortions: number;
  limitingIngredientName: string | null;
}
interface MenuItem {
  id: string;
  name: string;
  price: string;
  categoryId: string | null;
  // Sirovi Prisma include oblik (MenuItemModifierGroup join) — vidi
  // menu-service.ts listMenuItems. Prazan niz za artikle bez dodataka.
  modifierGroups: { group: ModifierGroup }[];
  // P3.3: prisutno SAMO kad je meni zatražen sa locationId (vidi load()
  // ispod) — null dok se ne učita, nikad se ne tumači kao OUT.
  stock: MenuItemStock | null;
  // P1.4: recepturisan (sirovinski) artikal — prisutno SAMO za artikle sa
  // konfigurisanim normativom, isto "null = ne primenjuje se" pravilo kao
  // stock. Nikad oba polja istovremeno smisleno "aktivna" (recepturisan
  // artikal ima trackStock isključen — vidi inventory-service.ts double-
  // deduction odbranu), ali oba se čitaju nezavisno radi jasnoće.
  recipeAvailability: RecipeAvailability | null;
}
interface OrderItemModifier {
  id: string;
  modifierOptionId: string | null;
  groupName: string;
  optionName: string;
  priceDelta: string;
}
interface OrderItem {
  id: string;
  menuItemId: string | null;
  name: string;
  price: string;
  quantity: number;
  note: string | null;
  status: "DRAFT" | "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  modifiers: OrderItemModifier[];
}

interface OrderData {
  id: string;
  status: string;
  guestCount: number | null;
  items: OrderItem[];
  table: { label: string };
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

const ITEM_STATUS_LABEL: Record<OrderItem["status"], string> = {
  DRAFT: "Nacrt",
  SUBMITTED: "Poslato",
  ACCEPTED: "Prihvaćeno",
  PREPARING: "U pripremi",
  READY: "Spremno",
  SERVED: "Servirano",
  CANCELLED: "Otkazano",
};

const ITEM_STATUS_TONE: Record<OrderItem["status"], string> = {
  DRAFT: "bg-ink/[0.06] text-inkSoft",
  SUBMITTED: "bg-info-soft text-info",
  ACCEPTED: "bg-gold-soft text-gold-dark",
  PREPARING: "bg-warn-soft text-warn",
  READY: "bg-success-soft text-success",
  SERVED: "bg-ink/[0.06] text-inkSoft",
  CANCELLED: "bg-danger-soft text-danger",
};

const MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

/**
 * Poništavanje POSLATE stavke — samo za menadžment (vidi order-access.ts).
 * Konobar ne sme da bude iznenađen praznim dugmetom koje uvek odbija, pa se
 * dugme uopšte ne prikazuje bez ovlašćenja (server ionako odbija i beleži
 * pokušaj — ovo je samo UX, ne bezbednosna granica).
 */
function VoidItemModal({
  item,
  onCancel,
  onConfirm,
}: {
  item: OrderItem;
  onCancel: () => void;
  onConfirm: (quantity: number, reasonCode: VoidReasonCode, explanation: string) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(item.quantity);
  const [reasonCode, setReasonCode] = useState<VoidReasonCode>(VOID_REASON_CODES[0]);
  const [explanation, setExplanation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const explanationValid = isMeaningfulVoidExplanation(explanation);

  async function confirm() {
    if (!explanationValid || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await onConfirm(quantity, reasonCode, explanation);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Greška pri poništavanju");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 sm:items-center" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-t-lg bg-white p-4 shadow-elevated sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-ink">Poništi stavku</h2>
        <p className="mb-4 text-sm text-ink/70">
          {item.name} × {item.quantity}
        </p>

        {item.quantity > 1 && (
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-inkSoft">Količina za poništavanje</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className="h-11 w-11 rounded-md border border-line text-lg font-semibold text-ink"
              >
                −
              </button>
              <span className="w-10 text-center text-lg font-semibold text-ink">{quantity}</span>
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.min(item.quantity, q + 1))}
                className="h-11 w-11 rounded-md border border-line text-lg font-semibold text-ink"
              >
                +
              </button>
              <span className="text-sm text-ink/55">od {item.quantity}</span>
            </div>
          </div>
        )}

        <div className="mb-4">
          <label className="mb-1.5 block text-sm font-medium text-inkSoft">Razlog</label>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as VoidReasonCode)}
            className="w-full rounded-md border border-line px-3 py-3 text-base"
          >
            {VOID_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {VOID_REASON_LABELS[code]}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3">
          <label className="mb-1.5 block text-sm font-medium text-inkSoft">Objašnjenje</label>
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={3}
            placeholder="Šta se tačno desilo?"
            className="w-full rounded-md border border-line px-3 py-2 text-base"
          />
          {!explanationValid && explanation.length > 0 && (
            <p className="mt-1 text-xs text-danger">Objašnjenje mora biti smisleno i dovoljno opisno.</p>
          )}
        </div>

        <div className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          Ova radnja se beleži u evidenciji. Molimo objasni šta se desilo.
        </div>

        {localError && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{localError}</div>}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-line py-3 text-base font-medium text-ink"
          >
            Otkaži
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!explanationValid || submitting}
            className="flex-1 rounded-md bg-danger py-3 text-base font-semibold text-white disabled:opacity-40"
          >
            {submitting ? "Poništavanje…" : "Potvrdi poništavanje"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Brzi izbor dodataka — otvara se SAMO za artikle koji imaju vezane grupe
 * (specifikacija #10: artikal bez dodataka zadržava postojeći brzi tap-add,
 * bez modala). Jednostavan single-tap toggle: grupe sa maxSelect<=1 se
 * ponašaju kao radio (tap zamenjuje prethodni izbor u toj grupi), ostale
 * kao checkbox do maxSelect granice.
 */
function ModifierSelectionModal({
  item,
  initialSelectedIds = [],
  confirmVerb = "Dodaj",
  onCancel,
  onConfirm,
}: {
  item: MenuItem;
  initialSelectedIds?: string[];
  confirmVerb?: string;
  onCancel: () => void;
  onConfirm: (optionIds: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelectedIds));
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const groups = useMemo(() => item.modifierGroups.map((g) => g.group).filter((g) => g.isActive), [item]);

  function toggle(group: ModifierGroup, optionId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const groupOptionIds = group.options.map((o) => o.id);
      const selectedInGroup = groupOptionIds.filter((id) => next.has(id));
      if (next.has(optionId)) {
        next.delete(optionId);
        return next;
      }
      if (group.maxSelect <= 1) {
        for (const id of selectedInGroup) next.delete(id);
        next.add(optionId);
        return next;
      }
      if (selectedInGroup.length >= group.maxSelect) return prev;
      next.add(optionId);
      return next;
    });
  }

  const effectivePrice = useMemo(() => {
    let total = Number(item.price);
    for (const g of groups) {
      for (const o of g.options) {
        if (selected.has(o.id)) total += Number(o.priceDelta);
      }
    }
    return total;
  }, [selected, groups, item.price]);

  const missingRequired = groups.some((g) => g.required && g.options.filter((o) => selected.has(o.id)).length < Math.max(1, g.minSelect));
  const canConfirm = !missingRequired;

  async function confirm() {
    if (!canConfirm || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await onConfirm(Array.from(selected));
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Greška pri dodavanju artikla");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40 sm:items-center" onClick={onCancel}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-lg bg-white shadow-elevated sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">{item.name}</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {groups.map((group) => {
            const isSingle = group.maxSelect <= 1;
            return (
              <div key={group.id} className="mb-5 last:mb-0">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink">
                    {group.name} {group.required && <span className="text-danger">*</span>}
                  </h3>
                  <span className="text-xs text-inkSoft">
                    {group.required ? "Obavezno" : "Opciono"}
                    {group.maxSelect > 1 ? ` · do ${group.maxSelect} izbora` : ""}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.options
                    .filter((o) => o.isActive)
                    .map((option) => {
                      const isSelected = selected.has(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggle(group, option.id)}
                          className={`flex min-h-12 w-full items-center justify-between rounded-md border px-3 py-2.5 text-left transition-colors ${
                            isSelected ? "border-gold bg-gold-soft" : "border-line bg-white hover:border-gold/50"
                          }`}
                        >
                          <span className="flex items-center gap-2.5 text-sm text-ink">
                            <span
                              className={`flex h-5 w-5 shrink-0 items-center justify-center border text-xs text-white ${
                                isSingle ? "rounded-full" : "rounded-sm"
                              } ${isSelected ? "border-gold bg-gold" : "border-line"}`}
                              aria-hidden="true"
                            >
                              {isSelected ? "✓" : ""}
                            </span>
                            {option.name}
                          </span>
                          {Number(option.priceDelta) > 0 && (
                            <span className="shrink-0 text-sm font-medium tabular-nums text-inkSoft">
                              +{Number(option.priceDelta).toFixed(0)} RSD
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
        {localError && <div className="mx-4 mb-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{localError}</div>}
        <div className="border-t border-line p-4">
          <div className="flex gap-3">
            <button type="button" onClick={onCancel} className="flex-1 rounded-md border border-line py-3 text-base font-medium text-ink">
              Otkaži
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!canConfirm || submitting}
              className="flex-[2] rounded-md bg-gold py-3 text-base font-semibold text-white disabled:opacity-40"
            >
              {submitting ? "Čuvanje…" : `${confirmVerb} — ${effectivePrice.toFixed(0)} RSD`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrderClient({ tableId }: { tableId: string }) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [voidingItem, setVoidingItem] = useState<OrderItem | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  // Artikal za koji je otvoren modal izbora dodataka (dodavanje nove stavke).
  const [modifierPickerItem, setModifierPickerItem] = useState<MenuItem | null>(null);
  // Postojeća DRAFT stavka čiji se dodaci uređuju (umesto dodavanja nove).
  const [editingModifiersFor, setEditingModifiersFor] = useState<OrderItem | null>(null);
  // P3.3: lokacija porudžbine — čuva se da bi pozadinsko osvežavanje statusa
  // zaliha (ispod) moglo da ponovi isti upit bez ponovnog otvaranja porudžbine.
  const [locationId, setLocationId] = useState<string | null>(null);

  const canVoid = useMemo(() => roles.some((r) => MANAGEMENT_ROLES.has(r)), [roles]);

  // Generisan JEDNOM po ekranu porudžbine i ponovo korišćen na svaki retry
  // — ovo je klijentska strana zaštite od dvostrukog slanja (server strana
  // je @@unique([restaurantId, idempotencyKey]) na Order tabeli).
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const orderRes = await apiFetch("/api/pos/orders", {
        method: "POST",
        body: JSON.stringify({ tableId }),
      });
      const orderId = orderRes.order.id;
      const orderLocationId = orderRes.order.locationId;
      setLocationId(orderLocationId);

      // P3.3: locationId prosleđen ovde — server dodaje status zalihe (OUT/
      // LOW/OK) SAMO za OVU lokaciju uz svaki artikal (specifikacija #41/#43).
      const [orderDetail, categoriesRes, itemsRes, meRes] = await Promise.all([
        apiFetch(`/api/pos/orders/${orderId}`),
        apiFetch(`/api/admin/menu/categories`),
        apiFetch(`/api/admin/menu/items?activeOnly=true&locationId=${orderLocationId}`),
        apiFetch(`/api/pos/me`),
      ]);

      setOrder(orderDetail.order);
      setCategories(categoriesRes.categories);
      setItems(itemsRes.items);
      setRoles(meRes.roles ?? []);
      if (!activeCategoryId && categoriesRes.categories.length > 0) {
        setActiveCategoryId(categoriesRes.categories[0].id);
      }
      if (orderDetail.order.status !== "DRAFT") setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  useEffect(() => {
    load();
  }, [load]);

  // Nakon slanja porudžbine, poll-uj status stavki da konobar vidi promene
  // sa kuhinje/šanka bez ručnog osvežavanja stranice (isti MVP pristup kao
  // KDS ekrani — polling na par sekundi, bez SSE potrošnje za sada).
  useEffect(() => {
    if (!order || order.status === "DRAFT") return;
    const interval = setInterval(async () => {
      try {
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch {
        // Tiha greška na pozadinskom osvežavanju — ne prekidaj rad konobara.
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.status]);

  // P3.3: dok konobar bira artikle (pre slanja), status zalihe se osvežava
  // umereno u pozadini — ne agresivno (specifikacija #17/#18: 5-15s, ne 1s).
  // Ne dira order/cart stanje, samo listu artikala menija.
  useEffect(() => {
    if (submitted || !locationId) return;
    const interval = setInterval(async () => {
      try {
        const itemsRes = await apiFetch(`/api/admin/menu/items?activeOnly=true&locationId=${locationId}`);
        setItems(itemsRes.items);
      } catch {
        // Tiha greška na pozadinskom osvežavanju — konobar i dalje može da radi
        // sa poslednjim poznatim stanjem; server ionako presuđuje pri dodavanju.
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [submitted, locationId]);

  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (search) return item.name.toLowerCase().includes(search.toLowerCase());
      return item.categoryId === activeCategoryId;
    });
  }, [items, activeCategoryId, search]);

  const total = useMemo(
    () => order?.items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0) ?? 0,
    [order]
  );

  // Sve izmene korpe (dodavanje/uklanjanje/promena količine) dele JEDNU
  // bravu — cartMutationRef je ref (sinhrono čitanje/pisanje, za razliku od
  // useState čiji je efekat vidljiv tek na sledećem render-u). Bez ovoga,
  // dva brza tap-a pre nego što prvi zahtev osveži order.items u state-u
  // oba čitaju ISTO zastarelo stanje i oba odluče da POSTuju nov red umesto
  // da drugi PATCH-uje postojeći — otkriveno testom, ne teorijski rizik.
  const cartMutationRef = useRef(false);

  async function withCartLock(fn: () => Promise<void>) {
    if (cartMutationRef.current) return;
    cartMutationRef.current = true;
    setCartBusy(true);
    try {
      await fn();
    } finally {
      cartMutationRef.current = false;
      setCartBusy(false);
    }
  }

  /**
   * Dodaje stavku sa (opciono praznim) skupom izabranih dodataka. Isti
   * "poklapanje pa inkrementiraj" obrazac kao ranije, samo sada poklapanje
   * zahteva I ISTI menuItemId I ISTI skup dodataka (specifikacija #46/#47)
   * — "Burger + sir" i "Burger + slanina" ostaju odvojeni redovi, ali dva
   * tapa na "Burger + sir" (bez obzira na redosled biranja) inkrementiraju
   * ISTI red.
   */
  async function addItemWithModifiers(menuItemId: string, modifierOptionIds: string[]) {
    if (!order) return;
    setError(null);
    await withCartLock(async () => {
      const existing = order.items.find(
        (i) => i.menuItemId === menuItemId && sameModifierSelection(i.modifiers, modifierOptionIds)
      );
      try {
        if (existing) {
          if (existing.quantity >= 50) return; // isto ograničenje kao addOrderItemSchema/updateOrderItemSchema
          await apiFetch(`/api/pos/orders/${order.id}/items/${existing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity: existing.quantity + 1 }),
          });
        } else {
          await apiFetch(`/api/pos/orders/${order.id}/items`, {
            method: "POST",
            body: JSON.stringify({ menuItemId, quantity: 1, modifierOptionIds }),
          });
        }
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška pri dodavanju artikla");
        throw e; // modal treba da prikaže grešku i ostane otvoren
      }
    });
  }

  /** Tap na artikal u meniju — brz dodatak bez modala kad nema grupa
   * dodataka (specifikacija #10), inače otvara ModifierSelectionModal. */
  /** P3.3: frontend je SAVETODAVNO — server (orders.addItem) je autoritet i
   * odbija dodavanje OUT artikla bez obzira na ovo (specifikacija #4/#7).
   * Ovo samo sprečava očigledno beskorisan zahtev i daje trenutnu povratnu
   * informaciju bez čekanja mrežnog odgovora. */
  function handleTapMenuItem(item: MenuItem) {
    if (cartBusy) return;
    if (item.stock?.stockStatus === "OUT") {
      setError(`${item.name} — nema na zalihama.`);
      return;
    }
    if (item.recipeAvailability?.status === "OUT") {
      const limiting = item.recipeAvailability.limitingIngredientName;
      setError(limiting ? `${item.name} — nema dovoljno sirovina (${limiting}).` : `${item.name} — nema dovoljno sirovina.`);
      return;
    }
    if (item.modifierGroups.length === 0) {
      addItemWithModifiers(item.id, []);
    } else {
      setModifierPickerItem(item);
    }
  }

  async function saveModifiersForExistingItem(item: OrderItem, modifierOptionIds: string[]) {
    if (!order) return;
    setError(null);
    await withCartLock(async () => {
      try {
        await apiFetch(`/api/pos/orders/${order.id}/items/${item.id}/modifiers`, {
          method: "PATCH",
          body: JSON.stringify({ modifierOptionIds }),
        });
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška pri izmeni dodataka");
        throw e;
      }
    });
  }

  async function removeItem(itemId: string) {
    if (!order) return;
    await withCartLock(async () => {
      try {
        await apiFetch(`/api/pos/orders/${order.id}/items/${itemId}`, { method: "DELETE" });
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška");
      }
    });
  }

  async function changeQuantity(item: OrderItem, nextQuantity: number) {
    if (!order) return;
    if (nextQuantity <= 0) {
      await removeItem(item.id);
      return;
    }
    if (nextQuantity > 50) return; // isto ograničenje kao updateOrderItemSchema
    setError(null);
    await withCartLock(async () => {
      try {
        await apiFetch(`/api/pos/orders/${order.id}/items/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ quantity: nextQuantity }),
        });
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška pri izmeni količine");
      }
    });
  }

  async function confirmVoid(quantity: number, reasonCode: VoidReasonCode, explanation: string) {
    if (!order || !voidingItem) return;
    await apiFetch(`/api/pos/orders/${order.id}/items/${voidingItem.id}/void`, {
      method: "POST",
      body: JSON.stringify({ quantity, reasonCode, explanation }),
    });
    const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
    setOrder(refreshed.order);
    setVoidingItem(null);
  }

  async function submit() {
    if (!order || submitting || submitted) return; // zaštita od dvostrukog klika na UI nivou
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/pos/orders/${order.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: idempotencyKeyRef.current }),
      });
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri slanju porudžbine");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-ink/55">Učitavanje…</div>;
  if (!order) return <div className="p-6 text-danger">{error ?? "Porudžbina nije pronađena"}</div>;

  if (submitted) {
    const allServed = order.items.every((i) => i.status === "SERVED" || i.status === "CANCELLED");
    return (
      <div className="flex min-h-screen flex-col p-4">
        <div className="mb-4 flex items-center justify-between">
          <button onClick={() => router.push("/waiter/tables")} className="inline-flex min-h-11 items-center text-sm font-medium text-gold-dark">
            ← Stolovi
          </button>
          <h1 className="text-lg font-semibold text-ink">{order.table.label}</h1>
          <div className="flex items-center gap-1">
            <QuickLockButton />
            <LogoutButton />
          </div>
        </div>

        <div className="mb-3 rounded-md bg-success-soft px-3 py-2 text-center text-sm font-medium text-success animate-fade-in">
          Porudžbina poslata — prati status ispod, osvežava se automatski.
        </div>
        {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

        <div className="space-y-2">
          {order.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-md border border-line bg-white p-3">
              <div>
                <div className="font-medium text-ink">
                  {item.quantity}× {item.name}
                </div>
                {item.modifiers.length > 0 && (
                  <div className="text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                )}
                {item.note && <div className="text-xs text-inkSoft italic">„{item.note}“</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${ITEM_STATUS_TONE[item.status]}`}>
                  {ITEM_STATUS_LABEL[item.status]}
                </span>
                {canVoid && item.status !== "CANCELLED" && item.quantity > 0 && (
                  <button onClick={() => setVoidingItem(item)} className="text-xs font-medium text-danger/70">
                    Poništi
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {voidingItem && (
          <VoidItemModal item={voidingItem} onCancel={() => setVoidingItem(null)} onConfirm={confirmVoid} />
        )}

        {allServed && (
          <div className="mt-4 rounded-md bg-info-soft px-3 py-2 text-center text-sm text-info">
            Sve stavke su servirane. Spremno za naplatu.
          </div>
        )}

        <button
          onClick={() => router.push(`/waiter/tables/${tableId}/bill`)}
          className="mt-6 w-full rounded-md bg-gold py-4 text-lg font-semibold text-white transition-colors hover:bg-gold-dark"
        >
          Račun / Naplata
        </button>
        <button
          onClick={() => router.push("/waiter/tables")}
          className="mt-3 w-full rounded-md bg-graphite py-3 text-base font-medium text-cream-100 transition-colors hover:bg-graphite-700"
        >
          Nazad na stolove
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-cream-200 pb-52">
      <div className="sticky top-0 z-20 border-b border-line bg-white/95 px-3 py-2.5 shadow-card backdrop-blur">
        <button onClick={() => router.push("/waiter/tables")} className="mb-1 inline-flex min-h-11 items-center text-xs font-semibold text-gold-dark">
          ← Stolovi
        </button>
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Aktivna porudžbina</p><h1 className="text-xl font-bold tracking-tight text-ink">{order.table.label}</h1></div>
          <div className="flex items-center gap-1">
            <QuickLockButton />
            <LogoutButton />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl">
        {error && <div className="mx-3 mt-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}

        <input
          className="m-3 h-12 w-[calc(100%-1.5rem)] rounded-md border border-line bg-white px-4 text-base shadow-sm focus:border-gold focus:outline-none"
          placeholder="Pretraga menija…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {!search && (
          <div className="sticky top-[73px] z-10 flex gap-2 overflow-x-auto border-y border-line/70 bg-cream-200/95 px-3 py-2 backdrop-blur">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategoryId(c.id)}
                className={`min-h-10 whitespace-nowrap rounded-md px-4 py-2 text-sm font-semibold transition-all ${
                  activeCategoryId === c.id ? "bg-graphite text-white shadow-sm" : "border border-line bg-white text-ink/75 hover:border-gold/50"
                }`}
              >
                {c.name}
            </button>
          ))}
        </div>
      )}

        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleItems.map((item) => {
            const isOut = item.stock?.stockStatus === "OUT" || item.recipeAvailability?.status === "OUT";
            const isLow = item.stock?.stockStatus === "LOW" || item.recipeAvailability?.status === "LOW";
            // Recepturisan artikal nema sopstveni "trenutno stanje" broj —
            // ima izračunate porcije (ograničavajuća sirovina), zato
            // dobija sopstveni jasan tekst umesto formatStockQty (koji
            // pretpostavlja InventoryItem.currentStock).
            const isRecipeItem = item.recipeAvailability !== null;
            return (
              <button
                key={item.id}
                onClick={() => handleTapMenuItem(item)}
                disabled={cartBusy || isOut}
                aria-disabled={isOut}
                className={`flex min-h-[104px] flex-col justify-between rounded-lg border p-4 text-left shadow-sm transition-all active:translate-y-px active:scale-[.98] disabled:opacity-60 ${
                  isOut ? "border-line bg-ink/[0.03]" : "border-line bg-white sm:hover:border-gold/60 sm:hover:shadow-card"
                }`}
              >
                <div className="font-semibold leading-snug text-ink">
                  {item.name}
                  {item.modifierGroups.length > 0 && <span className="ml-1.5 align-middle text-[10px] font-medium text-inkSoft">· dodaci</span>}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-base font-bold tabular-nums text-gold-dark">
                    {Number(item.price).toFixed(2)} <span className="text-[10px] font-semibold text-inkSoft">RSD</span>
                  </span>
                  {isOut && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
                      {isRecipeItem
                        ? item.recipeAvailability!.limitingIngredientName
                          ? `Nema dovoljno sirovina — ${item.recipeAvailability!.limitingIngredientName}`
                          : "Nema dovoljno sirovina"
                        : "Nema na zalihama"}
                    </span>
                  )}
                  {isLow && !isOut && (
                    <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">
                      {isRecipeItem ? `Još ${item.recipeAvailability!.availablePortions} porcija` : `Još ${formatStockQty(item.stock!.currentStock ?? "0")}`}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {visibleItems.length === 0 && <div className="col-span-full py-8 text-center text-ink/55">Nema artikala.</div>}
        </div>
      </div>

      {/* Sticky pregled porudžbine */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-line bg-white shadow-[0_-12px_32px_rgba(10,25,49,.12)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between border-b border-line/70 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Tekuća porudžbina</p><span className="rounded-md bg-ink/[.06] px-2 py-1 text-xs font-semibold tabular-nums">{order.items.reduce((n, item) => n + item.quantity, 0)} stavki</span></div>
        {/* max-h u dvh (ne fiksni px) da se prilagodi visini ekrana telefona;
            overscroll-contain sprečava da skrol "procuri" na stranicu iza;
            -webkit-overflow-scrolling: touch je neophodan na starijem iOS
            Safari-ju da bi ugnježdeni overflow-y-auto UNUTAR position:fixed
            uopšte bio touch-skrolabilan (poznato ograničenje) — bez ovoga
            konobar fizički ne može da dođe do poslednjih stavki na nekim
            uređajima. pb-3 (umesto py-2) ostavlja vidljiv razmak ispod
            poslednje stavke pre linije/Ukupno ispod. */}
        <div className="mx-auto max-h-[32dvh] w-full max-w-5xl overflow-y-auto overscroll-contain px-3 pt-2 pb-3 [-webkit-overflow-scrolling:touch]">
          {order.items.length === 0 && <div className="py-2 text-center text-sm text-ink/55">Nema stavki još.</div>}
          {order.items.map((item) => {
            const canEditModifiers = (items.find((mi) => mi.id === item.menuItemId)?.modifierGroups.length ?? 0) > 0;
            return (
            <div key={item.id} className="flex items-center gap-2 border-b border-line/50 py-2 text-sm last:border-0">
              <div className="min-w-0 flex-1">
                {canEditModifiers ? (
                  <button
                    type="button"
                    onClick={() => setEditingModifiersFor(item)}
                    disabled={cartBusy}
                    className="block w-full truncate text-left text-ink underline decoration-dotted underline-offset-2 disabled:opacity-60"
                    title={item.name}
                  >
                    {item.name}
                  </button>
                ) : (
                  <span className="block truncate text-ink" title={item.name}>
                    {item.name}
                  </span>
                )}
                {item.modifiers.length > 0 && (
                  <div className="truncate text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => changeQuantity(item, item.quantity - 1)}
                  disabled={cartBusy}
                  aria-label={`Umanji količinu — ${item.name}`}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-6 text-center font-medium text-ink">{item.quantity}</span>
                <button
                  type="button"
                  onClick={() => changeQuantity(item, item.quantity + 1)}
                  disabled={cartBusy || item.quantity >= 50}
                  aria-label={`Povećaj količinu — ${item.name}`}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                >
                  +
                </button>
              </div>
              <span className="w-20 shrink-0 text-right tabular-nums text-ink/70">{(Number(item.price) * item.quantity).toFixed(2)} RSD</span>
              <button
                onClick={() => removeItem(item.id)}
                disabled={cartBusy}
                className="shrink-0 text-xs text-danger/60 disabled:opacity-40"
              >
                Ukloni
              </button>
            </div>
            );
          })}
        </div>
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between border-t border-line px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-inkSoft">Ukupno</span>
          <span className="text-xl font-bold tabular-nums tracking-tight text-ink">{total.toFixed(2)} <span className="text-xs text-inkSoft">RSD</span>
          </span>
        </div>
        <div className="mx-auto w-full max-w-5xl px-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={submit}
            disabled={submitting || order.items.length === 0}
            className="min-h-14 w-full rounded-md bg-gold py-3 text-lg font-bold text-white shadow-sm transition-all hover:bg-gold-dark active:translate-y-px disabled:opacity-40"
          >
            {submitting ? "Slanje…" : "Pošalji porudžbinu"}
          </button>
        </div>
      </div>

      {modifierPickerItem && (
        <ModifierSelectionModal
          item={modifierPickerItem}
          onCancel={() => setModifierPickerItem(null)}
          onConfirm={async (optionIds) => {
            await addItemWithModifiers(modifierPickerItem.id, optionIds);
            setModifierPickerItem(null);
          }}
        />
      )}
      {editingModifiersFor && (() => {
        const menuItem = items.find((mi) => mi.id === editingModifiersFor.menuItemId);
        if (!menuItem) return null;
        return (
          <ModifierSelectionModal
            item={menuItem}
            initialSelectedIds={editingModifiersFor.modifiers.map((m) => m.modifierOptionId).filter((id): id is string => id !== null)}
            confirmVerb="Sačuvaj"
            onCancel={() => setEditingModifiersFor(null)}
            onConfirm={async (optionIds) => {
              await saveModifiersForExistingItem(editingModifiersFor, optionIds);
              setEditingModifiersFor(null);
            }}
          />
        );
      })()}
    </div>
  );
}
