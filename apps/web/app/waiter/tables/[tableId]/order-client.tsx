"use client";

import { useEffect, useState, useRef, useMemo, useSyncExternalStore, useLayoutEffect, useCallback, memo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../components/ui/QuickLockButton";
import { VOID_REASON_CODES, VOID_REASON_LABELS, isMeaningfulVoidExplanation, type VoidReasonCode } from "@rcs/shared";
import { filterMenuItems } from "../../../../lib/menu-search";
import { formatStockQty } from "../../../../lib/stock-format";
import { waiterTiming, waiterNavigationStart, waiterNavigationVisible } from "../../../../lib/waiter-performance";
import { useWaiterShell } from "../../../../lib/waiter-shell";

import { mergeWaiterMenu, menuSectionsForItem, type MenuItem, type MenuSection, type ModifierGroup } from "../../../../lib/waiter-menu";

import type { OrderData, OrderItem } from "../../../../lib/waiter-order-types";
import { tableMemory, quickSuggestions, repeatRound, resolveQuickSelection } from "../../../../lib/waiter-table-memory";
import { activeOrderView } from "../../../../lib/waiter-active-order";
import { sameModifierSelection } from "../../../../lib/order-cart";

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

async function inspectTable(tableId: string, locationId: string): Promise<OrderData | null> {
  const detail = await apiFetch(`/api/pos/orders?tableId=${encodeURIComponent(tableId)}`, { cache: "no-store" });
  if (detail.table?.id !== tableId || detail.table?.locationId !== locationId
    || (detail.order && (detail.order.locationId !== locationId || detail.order.tableId !== tableId))) throw new Error("Sto nije na pripremljenoj lokaciji");
  if (detail.order !== null && (!detail.order?.id || !Array.isArray(detail.order.items))) throw new Error("Porudžbina nije potpuna");
  return detail.order;
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
  return <TableOrderClient key={tableId} tableId={tableId} />;
}

function TableOrderClient({ tableId }: { tableId: string }) {
  const router = useRouter();
  useEffect(() => { waiterNavigationVisible("menu"); }, []);
  const { data: shell, refreshAvailability, getDraft, favorites } = useWaiterShell();
  const draft = getDraft(tableId);
  const { order, inspected, error, submitting } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const { setOrder, setError, mutations, submittingRef, submitRevision, idempotencyKeyRef, setSubmitting } = draft;
  useLayoutEffect(() => { draft.markVisible(); }, [draft, order]);
  const categories = shell.categories;
  const roles = shell.roles;
  const items = useMemo(() => mergeWaiterMenu(shell.items, shell.availabilityByItemId), [shell.items, shell.availabilityByItemId]);
  const itemById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const view = useMemo(() => activeOrderView(order), [order]);

  // DESKTOP SPLIT-VIEW / MOBILE PANEL — reveal a newly added draft item
  // without the waiter having to notice/scroll manually. Keyed ONLY on the
  // draft count INCREASING (a genuinely new item was added) — never on a
  // quantity change, a removal, or the count shrinking, and never on
  // already-submitted rows (a separate, read-only section) — so changing
  // quantity, removing an unrelated item, or a server poll updating
  // previously-sent items never yanks the scroll position out from under
  // the waiter mid-edit.
  const draftItemsScrollRef = useRef<HTMLDivElement>(null);
  const previousDraftCountRef = useRef(view.draftItems.length);
  useEffect(() => {
    const container = draftItemsScrollRef.current;
    // container.scrollTo isn't implemented in the jsdom unit-test
    // environment — harmless to skip there (no real scrolling to verify).
    if (container && view.draftItems.length > previousDraftCountRef.current && typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
    previousDraftCountRef.current = view.draftItems.length;
  }, [view.draftItems.length]);

  const memory = useMemo(() => tableMemory(view.sentItems), [view]);
  const suggestions = quickSuggestions(memory.recent, favorites.get(), items);
  const [quickFeedback, setQuickFeedback] = useState("");

  const searchInputRef = useRef<HTMLInputElement>(null);

  // DESKTOP SPLIT-VIEW (>=1280px/xl:): the order panel becomes a sticky
  // right column instead of a fixed bottom overlay, and must sit BELOW the
  // page's own sticky header rather than under it — its header content
  // (back button + table name) doesn't change across breakpoints, but its
  // rendered height isn't a safe constant to hardcode (font
  // rendering/OS zoom/future copy changes), so it's measured once and
  // exposed as a CSS variable the xl: styles below read from, instead of a
  // brittle guessed pixel value.
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const hasOrder = Boolean(order);
  useLayoutEffect(() => {
    const headerEl = headerRef.current;
    const rootEl = rootRef.current;
    if (!headerEl || !rootEl) return;
    const sync = () => rootEl.style.setProperty("--waiter-header-h", `${headerEl.offsetHeight}px`);
    sync();
    // Not available in the jsdom unit-test environment — the one-time sync()
    // above already covers those tests (they never resize the viewport);
    // every real browser this app targets supports ResizeObserver.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(headerEl);
    return () => observer.disconnect();
    // REAL PREPROD QA REGRESSION (Task #3 re-fix): this component has an
    // EARLY RETURN (`if (!order) return (...)`) with its OWN, DIFFERENT
    // JSX tree while the order is still loading — neither ref'd div below
    // exists yet at that point, so on the very first commit (order still
    // null) this effect ran with both refs null and no-opped. With an
    // empty dependency array it NEVER ran again once `order` populated and
    // React swapped in the main return's actual ref'd header/root divs, so
    // --waiter-header-h was NEVER set on any real order (confirmed via a
    // real headless-browser render: the CSS variable was empty and
    // `calc(100dvh - var(--waiter-header-h))` was therefore invalid CSS,
    // silently leaving the desktop row's height unconstrained — the exact
    // cause of the panel/menu never getting a real internal scroll
    // boundary that "34f476a" claimed to fix but a jsdom/geometry check
    // could never have caught, since jsdom doesn't lay out real pixel
    // heights. Depending on `Boolean(order)` makes the effect re-run
    // exactly once more, right when the real DOM (and refs) actually
    // mount, without re-subscribing on every subsequent order update.
  }, [hasOrder]);

  const [loading, setLoading] = useState(() => !draft.getSnapshot().inspected);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [voidingItem, setVoidingItem] = useState<OrderItem | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const [releasingTable, setReleasingTable] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  // FAZA 10: id stavke čije se PREUZETO trenutno šalje — sprečava dupli tap
  // dok zahtev traje (nezavisno od cartBusy, koje se odnosi na korpu).
  const [pickupBusyId, setPickupBusyId] = useState<string | null>(null);
  // Artikal za koji je otvoren modal izbora dodataka (dodavanje nove stavke).
  const [modifierPickerItem, setModifierPickerItem] = useState<MenuItem | null>(null);
  // Postojeća DRAFT stavka čiji se dodaci uređuju (umesto dodavanja nove).
  const [editingModifiersFor, setEditingModifiersFor] = useState<OrderItem | null>(null);

  const canVoid = useMemo(() => roles.some((r) => MANAGEMENT_ROLES.has(r)), [roles]);

  // Generisan JEDNOM po ekranu porudžbine i ponovo korišćen na svaki retry
  // — ovo je klijentska strana zaštite od dvostrukog slanja (server strana
  // je @@unique([restaurantId, idempotencyKey]) na Order tabeli).
  useEffect(() => () => { void draft.flush(false).catch(() => {}); }, [draft]);

  const loadRequest = useRef<Promise<{ value: OrderData | null; read: ReturnType<typeof draft.beginRead> }> | null>(null);
  // Start the async read at commit, before layout/paint of the prepared menu.
  // No network response is awaited on the rendering path.
  useLayoutEffect(() => {
    let active = true;
    loadRequest.current ??= (async () => {
      // Returning while a create is pending keeps the local cart visible;
      // the authoritative read must start after that known work has settled.
      if (draft.pending) await draft.flush(false);
      const read = draft.beginRead();
      const finishTiming = waiterTiming("order-open");
      const value = await inspectTable(tableId, shell.locationId);
      finishTiming();
      return { value, read };
    })();
    loadRequest.current.then(({ value, read }) => {
      if (active) {
        // Queue the loading flag before the external-store notification so
        // the first usable order does not need a second completion render.
        setLoading(false);
        draft.acceptRead(value, read);
      }
    })
      .catch(e => { if (active) { setLoading(false); setError(e instanceof Error ? e.message : "Porudžbina nije dostupna"); } });
    return () => { active = false; };
  }, [tableId, shell.locationId, draft, setError, inspectionAttempt]);

  const openingOrder = useRef(false);
  async function startOrder() {
    if (openingOrder.current || loading || draft.pending || draft.getSnapshot().order) return;
    openingOrder.current = true;
    setLoading(true); setError(null);
    const release = draft.holdReads();
    try {
      // Only explicit waiter intent may create an order. Preserve the existing
      // open/shift/audit transaction and its complete detail authorization.
      await mutations.enqueue(async () => {
        const opened = await apiFetch("/api/pos/orders", { method: "POST", body: JSON.stringify({ tableId }) });
        if (opened.order.locationId !== shell.locationId) throw new Error("Sto nije na pripremljenoj lokaciji");
        const detail = await apiFetch(`/api/pos/orders/${opened.order.id}`);
        if (detail.order?.id !== opened.order.id || detail.order?.tableId !== tableId
          || detail.order?.locationId !== shell.locationId || !Array.isArray(detail.order?.items)) throw new Error("Porudžbina nije potpuna");
        setOrder(detail.order);
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Porudžbina nije dostupna"); }
    finally { release(); openingOrder.current = false; setLoading(false); }
  }

  // Nakon slanja porudžbine, poll-uj status stavki da konobar vidi promene
  // sa kuhinje/šanka bez ručnog osvežavanja stranice (isti MVP pristup kao
  // KDS ekrani — polling na par sekundi, bez SSE potrošnje za sada).
  useEffect(() => {
    if (!inspected || order?.status === "COMPLETED" || order?.status === "CANCELLED") return;
    let active = true;
    let pending = false;
    const interval = setInterval(async () => {
      if (pending || draft.pending || submittingRef.current) return;
      pending = true;
      const read = draft.beginRead();
      try {
        const refreshed = order ? (await apiFetch(`/api/pos/orders/${order.id}`)).order : await inspectTable(tableId, shell.locationId);
        if (active) draft.acceptRead(refreshed, read);
      } catch {
        // Tiha greška na pozadinskom osvežavanju — ne prekidaj rad konobara.
      }
      finally { pending = false; }
    }, 4000);
    return () => { active = false; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.status, inspected]);

  // P3.3/P0.3: dok je porudžbina OTVORENA, status zalihe se osvežava umereno
  // u pozadini — ne agresivno (specifikacija #17/#18: 5-15s, ne 1s). VIŠE-
  // KRUŽNO NARUČIVANJE: NIKAD se ne gasi samo zato što je porudžbina već
  // BAR JEDNOM poslata — konobar može dodati naredni krug u bilo kom
  // trenutku dok je sto otvoren, pa svež meni/dostupnost i dalje mora da
  // stiže. Gasi se SAMO kad je porudžbina zatvorena (naplaćena/otkazana).
  // P0.3: sada zove ljusku (refreshAvailability, /api/pos/menu/availability
  // — mali live-only odgovor) umesto sopstvenog /api/admin/menu/items poziva
  // — isti okidač/kadenca, ali ažurira DELJENI overlay, pa sto na koji se
  // konobar vrati posle ovoga odmah vidi već svež overlay bez čekanja.
  useEffect(() => {
    if (!inspected || order?.status === "COMPLETED" || order?.status === "CANCELLED") return;
    const interval = setInterval(() => {
      refreshAvailability().catch(() => {
        // Tiha greška — vidi napomenu u waiter-shell.tsx refreshAvailability:
        // zadržava poslednje poznato autoritativno stanje, server ionako
        // presuđuje pri dodavanju.
      });
    }, 15000);
    return () => clearInterval(interval);
  }, [order?.status, inspected, refreshAvailability]);



  // Sve izmene korpe (dodavanje/uklanjanje/promena količine) dele JEDNU
  // bravu — cartMutationRef je ref (sinhrono čitanje/pisanje, za razliku od
  // useState čiji je efekat vidljiv tek na sledećem render-u). Bez ovoga,
  // dva brza tap-a pre nego što prvi zahtev osveži order.items u state-u
  // oba čitaju ISTO zastarelo stanje i oba odluče da POSTuju nov red umesto
  // da drugi PATCH-uje postojeći — otkriveno testom, ne teorijski rizik.
  const cartMutationRef = useRef(false);
  // Per-item debounce timers for the quantity stepper — rapid +/- taps
  // coalesce into ONE network call (the last requested quantity wins)
  // instead of firing a request per tap, while every tap still updates the
  // visible count instantly (see changeQuantity below). Keyed by orderItemId.


  async function withCartLock(fn: () => Promise<void>) {
    if (cartMutationRef.current || submittingRef.current) return;
    cartMutationRef.current = true;
    setCartBusy(true);
    try {
      await mutations.enqueue(fn);
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
  /**
   * PERF: mutation endpoints already return the created/updated OrderItem
   * (see apps/web/app/api/pos/orders/[id]/items/**) — merging that response
   * directly into local state removes the redundant second full-order GET
   * that used to follow every single mutation (halves the network round
   * trips per tap). The "existing item, +1" branch goes through the
   * optimistic changeQuantity path below instead of its own PATCH, so rapid
   * repeated taps on the same menu item ALSO benefit from its debounce.
   */
  function addItemWithModifiers(menuItemId: string, modifierOptionIds: string[]): boolean {
    if (submittingRef.current || !draft.getSnapshot().order) return false;
    const menu = itemById.get(menuItemId);
    if (!menu || menu.availability?.isAvailable !== true) return false;
    const existing = draft.add(menu, modifierOptionIds);
    if (existing && existing.quantity >= 50) return false;
    if (existing) void changeQuantity(existing, existing.quantity + 1);
    favorites.record(menuItemId, modifierOptionIds);
    return true;
  }

  /** Tap na artikal u meniju — brz dodatak bez modala kad nema grupa
   * dodataka (specifikacija #10), inače otvara ModifierSelectionModal. */
  /** P1.7: recorded stock (any level — negative, zero, low) NEVER blocks a
   * normal sale — TableCore's inventory is control/alerting, not a hard
   * sales gate (the restaurant may physically have the goods even if the
   * record is behind). The ONE remaining hard block is a RECIPE item with
   * no configured normative at all — TableCore genuinely doesn't know what
   * to deduct, that's a configuration failure, not a stock shortage. */
  function handleTapMenuItem(item: MenuItem) {
    if (submittingRef.current || item.availability?.isAvailable !== true) return;
    if (item.recipeAvailability !== null && !item.recipeAvailability.configured) {
      setError(`${item.name} — normativ nije podešen.`);
      return;
    }
    if (item.modifierGroups.length === 0) {
      addItemWithModifiers(item.id, []); // The draft controller displays background errors.
    } else {
      setModifierPickerItem(item);
    }
  }

  async function saveModifiersForExistingItem(item: OrderItem, modifierOptionIds: string[]) {
    if (!order || submittingRef.current) return;
    setError(null);
    await withCartLock(async () => {
      try {
        const res = await apiFetch(`/api/pos/orders/${order.id}/items/${item.id}/modifiers`, {
          method: "PATCH",
          body: JSON.stringify({ modifierOptionIds }),
        });
        setOrder((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? res.item : i)) } : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška pri izmeni dodataka");
        throw e;
      }
    });
  }

  /**
   * PERF: optimistic — the row disappears the instant the button is tapped;
   * the DELETE happens in the background. On failure the item is restored
   * and the error shown (server remains authoritative — this never touches
   * a SUBMITTED item, only DRAFT rows, same as before).
   */
  async function removeItem(itemId: string) {
    if (!order || submittingRef.current) return;
    if (draft.changePending(itemId, 0)) return;
    const removed = order.items.find((i) => i.id === itemId);
    if (!removed) return;
    setOrder((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev));
    mutations.cancel(itemId);
    await mutations.enqueue(async () => {
      try {
        await apiFetch(`/api/pos/orders/${order.id}/items/${itemId}`, { method: "DELETE" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Stavka nije uklonjena");
        try {
          const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
          draft.reconcileItem(refreshed.order, itemId);
        } catch { /* Keep the error visible; Submit will refuse this failed mutation. */ }
        throw e;
      }
    }).catch(() => {});
  }

  /**
   * PERF: true optimistic UI — the visible count updates on every tap,
   * immediately, with no network wait. Rapid repeated taps (+/- mashed a few
   * times in a row) coalesce into ONE PATCH per item (last quantity wins,
   * 350ms debounce) instead of one request per tap. Server remains
   * authoritative: on failure the whole order is re-fetched to reconcile
   * local state back to ground truth and a clear error is shown.
   */
  async function changeQuantity(item: OrderItem, nextQuantity: number) {
    if (!order || submittingRef.current) return;
    if (draft.changePending(item.id, nextQuantity)) return;
    draft.markQuantity();
    if (nextQuantity <= 0) {
      await removeItem(item.id);
      return;
    }
    if (nextQuantity > 50) return; // isto ograničenje kao updateOrderItemSchema
    setError(null);
    setOrder((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, quantity: nextQuantity } : i)) } : prev));

    const orderId = order.id;
    mutations.schedule(item.id, async () => {
        try {
          await apiFetch(`/api/pos/orders/${orderId}/items/${item.id}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity: nextQuantity }),
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : "Greška pri izmeni količine — vraćeno na prethodno stanje");
          try {
            const refreshed = await apiFetch(`/api/pos/orders/${orderId}`);
            draft.reconcileItem(refreshed.order, item.id);
          } catch {
            // Pozadinsko usklađivanje nakon greške — tiho preskoči, konobar
            // već vidi poruku o grešci iznad i može ručno da osveži.
          }
          throw e;
        }
    });
  }

  async function confirmVoid(quantity: number, reasonCode: VoidReasonCode, explanation: string) {
    if (!order || !voidingItem) return;
    const releaseReads = draft.holdReads();
    try {
      await apiFetch(`/api/pos/orders/${order.id}/items/${voidingItem.id}/void`, {
        method: "POST",
        body: JSON.stringify({ quantity, reasonCode, explanation }),
      });
      const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
      draft.reconcileItem(refreshed.order, voidingItem.id);
      setVoidingItem(null);
    } finally { releaseReads(); }
  }

  /**
   * FAZA 10 — PREUZETO: konobar potvrđuje da je fizički preuzeo SPREMNU
   * stavku sa kuhinje/šanka (READY -> SERVED). Optimistički — red nestaje iz
   * "SPREMNO ZA PREUZIMANJE" ODMAH; na grešku se vraća + prikazuje poruka
   * (isti obrazac kao removeItem/changeQuantity iznad). Server ostaje
   * autoritativan i za konkurentno preuzimanje (dva tapa/dva uređaja) — vidi
   * production-service.ts confirmPickup guard.
   */
  async function confirmPickup(item: OrderItem) {
    if (!order || pickupBusyId) return;
    const releaseReads = draft.holdReads();
    setPickupBusyId(item.id);
    setError(null);
    setOrder((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, status: "SERVED" } : i)) } : prev));
    try {
      await apiFetch(`/api/pos/orders/${order.id}/items/${item.id}/pickup`, { method: "POST" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri potvrdi preuzimanja");
      setOrder((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, status: "READY" } : i)) } : prev));
    } finally {
      setPickupBusyId(null);
      releaseReads();
    }
  }

  /**
   * OSLOBODI STO — konobar zatvara PRAZNU, nikad poslatu porudžbinu (gost
   * otišao pre naručivanja) bez čekanja menadžera. Vidljivo samo dok
   * !hasEverSubmitted (isti agregat kao readyItems/draftItems iznad — order
   * je i dalje DRAFT, ništa nikad nije otišlo kuhinji/šanku); jednom poslata
   * porudžbina mora ići kroz postojeći Void/otkazivanje tok, ne ovuda. Server
   * (releaseEmptyTable) ostaje autoritativan i za konkurentan Submit — ovo je
   * samo klijentska prva linija odbrane (pending mutacije/Submit-u-toku).
   */
  async function releaseTable() {
    if (!order || releasingTable || draft.pending || submittingRef.current) return;
    const hasDrafts = order.items.some((i) => i.status === "DRAFT" && i.quantity > 0);
    const message = hasDrafts
      ? "Osloboditi sto? Nesačuvane stavke u korpi biće odbačene i sto će ponovo biti slobodan."
      : "Osloboditi sto? Porudžbina je prazna i sto će ponovo biti slobodan.";
    if (!window.confirm(message)) return;
    const releaseReads = draft.holdReads();
    setReleasingTable(true);
    setError(null);
    try {
      await apiFetch(`/api/pos/orders/${order.id}/release`, { method: "POST" });
      // Confirmed-empty, not cold: avoids a "Pripremamo sto..." flash if the
      // waiter immediately reopens this same table.
      setOrder(null);
      waiterNavigationStart();
      router.push("/waiter/tables");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sto nije oslobođeno. Pokušajte ponovo.");
    } finally {
      setReleasingTable(false);
      releaseReads();
    }
  }

  async function submit() {
    // VIŠE-KRUŽNO NARUČIVANJE: dozvoljeno kad god postoji BAR JEDNA nova
    // (DRAFT) stavka — ne samo pre prvog slanja. Zaštita od dvostrukog
    // klika ostaje (submitting), plus "nema šta da se pošalje" provera na
    // UI nivou (server je i dalje autoritativan i bezbedno je no-op i bez
    // ovoga, vidi submitOrder).
    if (!order || submittingRef.current) return;
    const hasDraftItems = order.items.some((i) => i.status === "DRAFT");
    if (!hasDraftItems) return;
    submittingRef.current = true;
    submitRevision.current++;
    setSubmitting(true);
    setError(null);
    try {
      await draft.flush();
      const res = await apiFetch(`/api/pos/orders/${order.id}/submit`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: idempotencyKeyRef.current }),
      });
      setOrder(res.order);
      // Sveža idempotencyKey za SLEDEĆI krug — ista ne sme se ponovo
      // koristiti (server je koristi i za PrintJob dispatchKey ovog kruga,
      // vidi order-service.ts submitOrder/print-service.ts).
      idempotencyKeyRef.current = crypto.randomUUID();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri slanju porudžbine");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const tapMenu = useCommittedCallback(handleTapMenuItem);
  const quickAdd = useCommittedCallback((id: string, options: string[]) => {
    if (resolveQuickSelection({ menuItemId: id, options }, items)) addItemWithModifiers(id, options);
  });
  const updateQuantity = useCommittedCallback(changeQuantity);
  const deleteItem = useCommittedCallback(removeItem);

  if (!order && !inspected) return (
    <div className="min-h-screen bg-cream-200 p-3" aria-busy={loading}>
      <button onClick={() => { waiterNavigationStart(); router.push("/waiter/tables"); }} className="min-h-11 text-gold-dark">← Stolovi</button>
      <h1 className="text-xl font-bold">{shell.floors.flatMap(f => f.tables).find(t => t.id === tableId)?.label ?? "Porudžbina"}</h1>
      <div className="mx-auto flex min-h-[60vh] w-full max-w-5xl items-center justify-center">
        <div role="status" className="rounded-lg border border-line bg-white p-6 text-center text-inkSoft">
          <p>{loading ? "Pripremamo sto i porudžbinu…" : error ?? "Porudžbina nije dostupna"}</p>
          {!loading && <button type="button" className="mt-3 min-h-12 rounded-md bg-gold-soft px-4 font-semibold text-gold-dark"
            onClick={() => { loadRequest.current = null; setError(null); setLoading(true); setInspectionAttempt(value => value + 1); }}>Pokušaj ponovo</button>}
        </div>
      </div>
    </div>
  );

  if (!order) return (
    <div className="min-h-screen bg-cream-200 p-3">
      <div>
      <button onClick={() => { waiterNavigationStart(); router.push("/waiter/tables"); }} className="min-h-11 text-gold-dark">← Stolovi</button>
      <h1 className="text-xl font-bold">{shell.floors.flatMap(f => f.tables).find(t => t.id === tableId)?.label ?? "Porudžbina"}</h1>
      </div>
      <div className="mx-auto w-full max-w-5xl">
      <p role="status" className="py-3">{loading ? "Otvaramo porudžbinu…" : error ?? "Sto nema aktivnu porudžbinu."}</p>
      {!loading && !error && <button type="button" onClick={startOrder} className="min-h-12 rounded-md bg-gold px-5 py-3 font-semibold text-white">Započni porudžbinu</button>}
      {/* Otvaranje porudžbine (loading) ne sme prikazati napola inicijalizovan
          meni ispod statusa — isti princip kao "Pripremamo sto..." ranu grananje. */}
      {!loading && <MenuBrowser key="menu" items={items} categories={categories} submitting={true} tapMenu={tapMenu} searchInputRef={searchInputRef} />}
      </div>
    </div>
  );

  const { historyItems: sentItems, hasEverSubmitted, draftItems, readyItems, draftCount, draftTotal } = view;
  const allServed = sentItems.length > 0 && sentItems.every((i) => i.status === "SERVED" || i.status === "CANCELLED");

  // pb-[28rem]: rezervisan prostor na dnu STRANICE (ne panela) da meni-grid
  // ne završi vizuelno ispod fiksnog panela — mora biti VEĆI od panelovog
  // realnog max-h (min(62dvh,34rem)) plus header/footer da bi poslednji red
  // menija ostao dostižan skrolom stranice čak i kad je panel pun. Nepotrebno
  // (i pogrešno) na desktop split-view-u (xl:) — panel tamo više nije fiksni
  // preklop preko dna stranice, već sticky desna kolona pored menija.
  return (
    <div ref={rootRef} className="flex min-h-screen flex-col bg-cream-200 pb-[28rem] xl:pb-0">
      <div ref={headerRef} className="sticky top-0 z-20 border-b border-line bg-white/95 px-3 py-2.5 shadow-card backdrop-blur">
        <button onClick={() => { waiterNavigationStart(); router.push("/waiter/tables"); }} className="mb-1 inline-flex min-h-11 items-center text-xs font-semibold text-gold-dark">
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

      {/* DESKTOP SPLIT-VIEW (>=1280px/xl:) — menu (left, ~68%) and the
          current-order panel (right, ~32%) become flex siblings in one row
          instead of the panel overlaying the bottom of the page.

          The row itself is bound to the remaining viewport height
          (100dvh - measured header height, see --waiter-header-h) and
          clips overflow, so EACH column scrolls independently within its
          own box instead of the whole page scrolling. Regression found
          while validating this: `position: sticky` on the panel (the
          original approach) only stays visible while its containing block
          (this row, auto-height = the taller of the two columns) hasn't
          scrolled past — for any real menu taller than the panel, once
          the waiter scrolled near the bottom of the menu the panel's
          containing block ran out and the ENTIRE panel (including its
          own already-correct internal item-list scroll, its total and its
          submit button) scrolled away with the page. A fixed-height,
          overflow-hidden row with two independently-scrolling children
          has no such limit — the panel is exactly as tall as the row for
          as long as the row exists, so its own internal
          header/items/total/submit structure below is always reachable.
          Below xl: this is an inert wrapper (no flex/height/etc. applied),
          so tablet/mobile keep the exact existing stacked/fixed-panel,
          whole-page-scrolls layout. */}
      <div className="xl:mx-auto xl:flex xl:h-[calc(100dvh-var(--waiter-header-h))] xl:w-full xl:max-w-[1600px] xl:gap-4 xl:overflow-hidden xl:px-4 xl:pb-4">
      <div className="mx-auto w-full max-w-5xl xl:mx-0 xl:h-full xl:min-w-0 xl:max-w-none xl:flex-[68] xl:overflow-y-auto xl:overscroll-contain">
        {(error || draft.retryable) && <div className="mx-3 mt-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error ?? "Izmena nije potvrđena."}{draft.retryable && <button onClick={draft.retry} className="ml-3 min-h-11 underline">Pokušaj ponovo</button>}</div>}

        {/* FAZA 10: najistaknutija sekcija na ekranu kad postoji bar jedna
            SPREMNA stavka — konobar mora ovo da primeti PRE menija/istorije.
            Svaka stavka se potvrđuje NEZAVISNO (sopstveno dugme), nikad
            čekanje da CEO sto/porudžbina bude spremna odjednom. */}
        {readyItems.length > 0 && (
          <div className="m-3 rounded-md border-2 border-gold bg-gold-soft p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em] text-gold-dark">Spremno za preuzimanje</p>
            <div className="space-y-2">
              {readyItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2.5 shadow-sm">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink">
                      {item.quantity}× {item.name}
                    </div>
                    {item.modifiers.length > 0 && (
                      <div className="truncate text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => confirmPickup(item)}
                    disabled={pickupBusyId === item.id}
                    className="min-h-11 shrink-0 rounded-md bg-gold px-4 text-sm font-bold text-white transition-all hover:bg-gold-dark active:translate-y-px disabled:opacity-40"
                  >
                    {pickupBusyId === item.id ? "…" : "Preuzeto"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasEverSubmitted && (
          <div className="p-3">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Poslato / U pripremi</p>
            {/* max-h + overflow-y-auto (isti obrazac kao DODATNA PORUDŽBINA
                korpa ispod) — BEZ ovoga, porudžbina sa mnogo već poslatih
                stavki gura pretragu/meni daleko ispod pregiba ekrana (pogotovo
                na mobilnom sa otvorenom tastaturom dok konobar kuca pretragu),
                što je izgledalo kao da pretraga "ne vraća ništa" iako je meni
                bio ispravno učitan — samo nedostupan bez dužeg skrolovanja. */}
            <div className="max-h-[24dvh] space-y-2 overflow-y-auto rounded-md border border-line bg-white p-3">
              {sentItems.map(item => <HistoryRow key={item.id} item={item} canVoid={canVoid} setVoidingItem={setVoidingItem} />)}
            </div>

            {allServed && draftItems.length === 0 && (
              <div className="mt-3 rounded-md bg-info-soft px-3 py-2 text-center text-sm text-info">
                Sve stavke su servirane. Spremno za naplatu.
              </div>
            )}

            <button
              onClick={() => router.push(`/waiter/tables/${tableId}/bill`)}
              className="mt-3 w-full rounded-md bg-gold py-3.5 text-base font-semibold text-white transition-colors hover:bg-gold-dark"
            >
              Račun / Naplata
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                onClick={() => router.push(`/waiter/tables/${tableId}/split-bill`)}
                className="rounded-md border-2 border-gold/60 bg-white py-2.5 text-sm font-semibold text-gold-dark transition-colors hover:bg-gold-soft"
              >
                Podeli račun
              </button>
              <button
                onClick={() => router.push(`/waiter/tables/${tableId}/transfer`)}
                className="rounded-md border-2 border-line bg-white py-2.5 text-sm font-semibold text-ink transition-colors hover:border-gold/50"
              >
                Prebaci stavke
              </button>
            </div>
          </div>
        )}

        {voidingItem && (
          <VoidItemModal item={voidingItem} onCancel={() => setVoidingItem(null)} onConfirm={confirmVoid} />
        )}

        {(suggestions.length > 0 || memory.lastRound.length > 0) && (
          <section aria-label="Brzo dodaj" className="mx-3 mt-3 rounded-lg border border-line bg-white p-3">
            <QuickActionSlider title="Brzo dodaj · Prethodno / Moji favoriti" selections={suggestions} items={items} submitting={submitting} add={quickAdd} />
            {memory.lastRound.length > 0 && <button type="button" disabled={submitting}
              onClick={() => setQuickFeedback(repeatRound(memory.lastRound, items, addItemWithModifiers))}
              className="mt-2 min-h-12 w-full rounded-md bg-gold-soft px-4 font-semibold text-gold-dark disabled:opacity-50">Ponovi poslednju rundu</button>}
            {quickFeedback && <p role="status" className="mt-2 text-sm text-inkSoft">{quickFeedback}</p>}
          </section>
        )}

        {hasEverSubmitted ? (
          <button
            type="button"
            onClick={() => {
              // scrollIntoView PRE focus() — na mobilnom, fokusiranje inputa
              // otvara tastaturu i smanjuje vidljivi viewport PRE nego što se
              // skrol izvrši, što bi skrolovanje učinilo nepouzdanim/kasnim.
              // Ovo garantuje da meni postane dostupan ODMAH, bez obzira
              // koliko je već poslatih stavki iznad (vidi napomenu uz max-h
              // na "Poslato / U pripremi" iznad — ovo je druga, nezavisna
              // linija odbrane za isti problem).
              searchInputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              searchInputRef.current?.focus();
            }}
            className="mx-3 mt-2 flex min-h-14 w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-md bg-gold text-base font-bold text-white shadow-sm transition-all hover:bg-gold-dark active:translate-y-px"
          >
            + Dodaj još u porudžbinu
          </button>
        ) : (
          <p className="mx-3 mt-1 text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Izaberi artikle</p>
        )}

        <MenuBrowser key="menu" items={items} categories={categories} submitting={submitting} tapMenu={tapMenu} searchInputRef={searchInputRef} />
      </div>

      {/* Sticky pregled porudžbine — FLEX KOLONA sa eksplicitnim gornjim
          ograničenjem visine (max-h na SPOLJNOM panelu, ne na stavkama
          pojedinačno kao ranije). Header/footer su shrink-0 (fiksne
          visine, nikad se ne skupljaju); JEDINO stavke (flex-1 min-h-0
          overflow-y-auto) rastu/skupljaju se da popune šta god preostane
          UNUTAR tog ograničenja. min-h-0 je OBAVEZAN — flex stavka bez
          njega ne može da se skupi ispod svoje "prirodne" (sadržajem
          određene) visine ni kad ima flex-1, što bi (stari bug) gurnulo
          footer (Ukupno/dugme) DOLE, van vidljivog panela, kad ima dosta
          stavki. Ranija verzija je bodovala max-h SAMO na listi stavki
          (32dvh), a spoljni panel nije imao sopstveni plafon — na kraćim
          telefonima/sa dosta stavki, ceo panel (header+lista+footer+dugme)
          je mogao da preraste vidljivi deo ekrana, gurajući poslednje
          stavke (i deo footer-a) IZNAD vrha ekrana, van domašaja skrola
          (position:fixed se ne "skraćuje" sam od sebe uz sadržaj).

          DESKTOP SPLIT-VIEW (xl:): isti panel, ista unutrašnja struktura
          (header/lista/footer/dugme), samo drugačiji SPOLJNI kontekst — sad
          obična flex stavka koja popunjava PUNU visinu reda (xl:h-full),
          a red je već ograničen na preostalu visinu ekrana (vidi wrapper
          red iznad, xl:h-[calc(100dvh-var(--waiter-header-h))]). Ranije je
          ovo bilo position:sticky, ali sticky element ne može da ostane
          vidljiv dalje od granica svog containing block-a (ovaj red, čija
          auto-visina prati VIŠU od dve kolone) — za bilo koji stvaran meni
          duži od panela, kad bi konobar skrolovao blizu dna menija, CEO
          panel (uklj. već ispravnu unutrašnju listu/total/dugme) bi
          nestao zajedno sa stranicom. xl:h-full na fiksno-visokom redu
          nema tu granicu. min-w/max-w garantuju čitljivu širinu
          (naziv/količina/cena/total) na bilo kojoj desktop rezoluciji —
          nikad se ne skuplja ispod min-w bez obzira na flex-shrink. */}
      <div className="fixed bottom-0 left-0 right-0 z-20 flex max-h-[min(62dvh,34rem)] flex-col border-t border-line bg-white shadow-[0_-12px_32px_rgba(10,25,49,.12)] xl:static xl:inset-auto xl:h-full xl:max-h-none xl:w-[32%] xl:min-w-[320px] xl:max-w-[420px] xl:shrink-0 xl:flex-[32] xl:rounded-lg xl:border xl:border-line xl:shadow-card">
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between border-b border-line/70 px-3 py-2 xl:mx-0 xl:max-w-none"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Tekuća porudžbina</p><span className="rounded-md bg-ink/[.06] px-2 py-1 text-xs font-semibold tabular-nums">{draftCount} stavki</span></div>
        {/* overscroll-contain sprečava da skrol "procuri" na stranicu iza;
            -webkit-overflow-scrolling: touch je neophodan na starijem iOS
            Safari-ju da bi ugnježdeni overflow-y-auto UNUTAR position:fixed
            uopšte bio touch-skrolabilan (poznato ograničenje) — bez ovoga
            konobar fizički ne može da dođe do poslednjih stavki na nekim
            uređajima. pb-3 (umesto py-2) ostavlja vidljiv razmak ispod
            poslednje stavke pre linije/Ukupno ispod. */}
        <div ref={draftItemsScrollRef} className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-3 [-webkit-overflow-scrolling:touch]">
          {draftItems.length === 0 && (
            <div className="py-2 text-center text-sm text-ink/55">
              {hasEverSubmitted ? "Nema novih stavki." : "Nema stavki još."}
            </div>
          )}
          {/* Physical-device regression fix: this panel represents ONLY the
              unsent round being composed. Already-submitted rows are shown
              exactly once, in the read-only "Poslato / U pripremi" section
              above — rendering them again here (as previously) duplicated
              every submitted/served row underneath itself. */}
          {draftItems.map(item => <DraftRow key={item.id} item={item} canEditModifiers={(itemById.get(item.menuItemId ?? "")?.modifierGroups.length ?? 0) > 0} cartBusy={cartBusy} submitting={submitting} hasEverSubmitted={hasEverSubmitted} setEditingModifiersFor={setEditingModifiersFor} changeQuantity={updateQuantity} removeItem={deleteItem} />)}
        </div>
        <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between border-t border-line px-3 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-inkSoft">Ukupno (novo)</span>
          <span className="text-2xl font-bold tabular-nums tracking-tight text-ink">{draftTotal.toFixed(2)} <span className="text-xs font-semibold text-inkSoft">RSD</span>
          </span>
        </div>
        <div className="mx-auto w-full max-w-5xl shrink-0 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={submit}
            disabled={submitting || draftItems.length === 0}
            className="min-h-14 w-full rounded-md bg-gold py-3 text-lg font-bold text-white shadow-sm transition-all hover:bg-gold-dark active:translate-y-px disabled:opacity-40"
          >
            {submitting ? "Slanje…" : hasEverSubmitted ? "Pošalji nove stavke" : "Pošalji porudžbinu"}
          </button>
          {/* Secondary, compact — never competes with Submit above. Only ever
              visible while nothing has been sent to Kitchen/Bar (see releaseTable). */}
          {!hasEverSubmitted && (
            <button
              type="button"
              onClick={releaseTable}
              disabled={releasingTable || submitting || draft.pending}
              className="mt-1.5 min-h-9 w-full text-center text-xs font-semibold text-ink/45 underline decoration-dotted underline-offset-2 disabled:opacity-40"
            >
              {releasingTable ? "Oslobađanje…" : "Oslobodi sto"}
            </button>
          )}
        </div>
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


const QuickActionSlider = memo(function QuickActionSlider({ title, selections, items, submitting, add }: { title: string; selections: ReturnType<typeof quickSuggestions>; items: MenuItem[]; submitting: boolean; add: (id: string, options: string[]) => void }) {
  if (!selections.length) return null;
  return <div role="group" aria-label={title} className="mb-2 last:mb-0">
    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-inkSoft">{title}</p>
    <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1">
      {selections.map(selection => {
        const menu = resolveQuickSelection(selection, items)!;
        const names = menu.modifierGroups.flatMap(({ group }) => group.options.filter(option => selection.options.includes(option.id)).map(option => option.name));
        const label = [menu.name, ...names].join(" · ");
        return <button key={JSON.stringify([selection.menuItemId, [...selection.options].sort()])} type="button" aria-label={`Brzo dodaj — ${label}`} disabled={submitting}
          onClick={() => add(selection.menuItemId, selection.options)}
          className="min-h-12 shrink-0 rounded-md border border-line px-4 text-sm font-semibold text-ink disabled:opacity-50">
          {label} <span className="text-gold-dark">+1</span>{selection.source === "favorite" && <span className="ml-1 text-xs text-inkSoft">★</span>}
        </button>;
      })}
    </div>
  </div>;
}, (previous, next) => previous.title === next.title && previous.items === next.items
  && previous.submitting === next.submitting && previous.add === next.add
  && previous.selections.length === next.selections.length && previous.selections.every((selection, index) => {
    const other = next.selections[index];
    // Scores/timestamps do not render. Order, selection and favorite badge do.
    return selection.menuItemId === other.menuItemId && selection.source === other.source
      && sameModifierSelection(selection.options.map(modifierOptionId => ({ modifierOptionId })), other.options);
  }));

const MenuGrid = memo(function MenuGrid({ visibleItems, submitting, handleTapMenuItem }: { visibleItems: MenuItem[]; submitting: boolean; handleTapMenuItem: (item: MenuItem) => void }) {
  return (
        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleItems.map((item) => {
            // P1.7: recorded stock level is advisory ONLY — never disables
            // the button. The ONE surviving hard block is a RECIPE item
            // with no configured normative (handleTapMenuItem enforces
            // this server-side too).
            const notConfigured = item.recipeAvailability !== null && !item.recipeAvailability.configured;
            // Operativna dostupnost (Kuhinja/Šank "NIJE DOSTUPNO") — tvrd
            // blok, POTPUNO nezavisan od zalihe/normativa iznad. Vidi
            // availability-service.ts.
            const isUnavailable = item.availability?.isAvailable !== true;
            const isBlocked = notConfigured || isUnavailable;
            const level = item.stock?.stockStatus ?? item.recipeAvailability?.status ?? null;
            const isNegativeOrOut = level === "NEGATIVE" || level === "OUT";
            const isLow = level === "LOW";
            // Recepturisan artikal nema sopstveni "trenutno stanje" broj —
            // ima izračunate porcije (ograničavajuća sirovina), zato
            // dobija sopstveni jasan tekst umesto formatStockQty (koji
            // pretpostavlja InventoryItem.currentStock).
            const isRecipeItem = item.recipeAvailability !== null;
            return (
              <button
                key={item.id}
                onClick={() => handleTapMenuItem(item)}
                disabled={submitting || isBlocked}
                aria-disabled={isBlocked}
                className={`flex min-h-[104px] flex-col justify-between rounded-lg border p-4 text-left shadow-sm transition-all active:translate-y-px active:scale-[.98] disabled:opacity-60 ${
                  isUnavailable
                    ? "border-danger/50 bg-danger-soft"
                    : notConfigured
                      ? "border-line bg-ink/[0.03]"
                      : "border-line bg-white sm:hover:border-gold/60 sm:hover:shadow-card"
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
                  {isUnavailable && (
                    <span className="rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">NIJE DOSTUPNO</span>
                  )}
                  {!isUnavailable && notConfigured && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
                      Normativ nije podešen
                    </span>
                  )}
                  {/* P1.7 §20: simple advisory for the waiter, never quantities/negative
                      jargon — OWNER/ADMIN/MANAGER get the full picture on Zalihe/Sirovine.
                      Vizuelno namerno SEKUNDARNO (soft ton, bez pune ispune) — artikal se
                      i dalje normalno naručuje, ovo nikad ne sme izgledati kao "Normativ
                      nije podešen" (jedino stvarno blokirano stanje) iznad. */}
                  {!isBlocked && isNegativeOrOut && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-medium text-danger">
                      {isRecipeItem ? "Proveri zalihu" : "Nema evidentirane zalihe"}
                    </span>
                  )}
                  {!isBlocked && isLow && (
                    <span className="text-[10px] font-medium text-warn">
                      {isRecipeItem ? `Još ${item.recipeAvailability!.availablePortions} porcija` : `Još ${formatStockQty(item.stock!.currentStock ?? "0")}`}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {visibleItems.length === 0 && <div className="col-span-full py-8 text-center text-ink/55">Nema artikala.</div>}
        </div>
  );
});

const CategoryNavigation = memo(function CategoryNavigation({ categories, activeCategoryId, setActiveCategoryId }: { categories: ReturnType<typeof useWaiterShell>["data"]["categories"]; activeCategoryId: string | null; setActiveCategoryId: (id: string) => void }) { return (<div className="sticky top-[73px] z-10 flex gap-2 overflow-x-auto border-y border-line/70 bg-cream-200/95 px-3 py-2 backdrop-blur">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategoryId(c.id)}
                className={`min-h-11 whitespace-nowrap rounded-md px-4 py-2.5 text-sm font-semibold transition-all ${
                  activeCategoryId === c.id ? "bg-graphite text-white shadow-card" : "border border-line bg-white text-ink/75 hover:border-gold/50"
                }`}
              >
                {c.name}
            </button>
          ))}
        </div>); });

const HistoryRow = memo(function HistoryRow({ item, canVoid, setVoidingItem }: { item: OrderItem; canVoid: boolean; setVoidingItem: (item: OrderItem) => void }) { return (<div className="flex items-center justify-between border-b border-line/50 pb-2 text-sm last:border-0 last:pb-0">
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
                </div>); });

const DraftRow = memo(function DraftRow({ item, canEditModifiers, cartBusy, submitting, hasEverSubmitted, setEditingModifiersFor, changeQuantity, removeItem }: { item: OrderItem; canEditModifiers: boolean; cartBusy: boolean; submitting: boolean; hasEverSubmitted: boolean; setEditingModifiersFor: (item: OrderItem) => void; changeQuantity: (item: OrderItem, quantity: number) => Promise<void>; removeItem: (id: string) => Promise<void> }) { return (<div className="border-b border-line/50 py-2.5 text-sm last:border-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {canEditModifiers ? (
                      <button
                        type="button"
                        onClick={() => setEditingModifiersFor(item)}
                        disabled={cartBusy || submitting || Boolean(item.localStatus)}
                        className="text-left font-medium text-ink underline decoration-dotted underline-offset-2 disabled:opacity-60"
                      >
                        {item.name}
                      </button>
                    ) : (
                      <span className="font-medium text-ink">{item.name}</span>
                    )}
                    {hasEverSubmitted && (
                      <span className="shrink-0 rounded-full bg-success-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-success">
                        Novo
                      </span>
                    )}
                  </div>
                  {item.modifiers.length > 0 && (
                    <div className="text-xs text-inkSoft">{item.modifiers.map((m) => m.optionName).join(", ")}</div>
                  )}
                </div>
                <span className="shrink-0 pt-0.5 text-right font-semibold tabular-nums text-ink">
                  {(Number(item.price) * item.quantity).toFixed(2)} <span className="text-xs font-normal text-inkSoft">RSD</span>
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => changeQuantity(item, item.quantity - 1)}
                    disabled={submitting}
                    aria-label={`Umanji količinu — ${item.name}`}
                    className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-6 text-center font-medium text-ink">{item.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQuantity(item, item.quantity + 1)}
                    disabled={submitting || item.quantity >= 50}
                    aria-label={`Povećaj količinu — ${item.name}`}
                    className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-cream-200 text-base font-semibold text-ink active:translate-y-px disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
                <button
                  onClick={() => removeItem(item.id)}
                  disabled={submitting}
                  aria-label={`Ukloni — ${item.name}`}
                  className="px-2 py-2 text-xs text-danger/55 disabled:opacity-40"
                >
                  Ukloni
                </button>
              </div>
            </div>); });

function useCommittedCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const ref = useRef(callback);
  useLayoutEffect(() => { ref.current = callback; });
  return useCallback((...args: Args) => ref.current(...args), []);
}

const SECTION_LABEL: Record<MenuSection, string> = { KITCHEN: "KUHINJA", BAR: "ŠANK" };

// Presentation switch only — local state, no fetch. See waiter-menu.ts menuSectionsForItem.
const SectionSwitch = memo(function SectionSwitch({ section, setSection }: { section: MenuSection; setSection: (next: MenuSection) => void }) {
  return (
    <div role="tablist" aria-label="Odeljak menija" className="mx-3 mb-1 mt-2 inline-flex gap-1 rounded-md border border-line bg-white p-1">
      {(["KITCHEN", "BAR"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={section === value}
          onClick={() => setSection(value)}
          className={`min-h-9 rounded px-5 text-sm font-bold transition-all ${
            section === value ? "bg-graphite text-white shadow-card" : "text-ink/60"
          }`}
        >
          {SECTION_LABEL[value]}
        </button>
      ))}
    </div>
  );
});

// Browsing state is local to the menu: category/search/section never rebuild the order panel.
const MenuBrowser = memo(function MenuBrowser({ items, categories, submitting, tapMenu, searchInputRef }: { items: MenuItem[]; categories: ReturnType<typeof useWaiterShell>["data"]["categories"]; submitting: boolean; tapMenu: (item: MenuItem) => void; searchInputRef: React.RefObject<HTMLInputElement> }) {
  const categoryTypeById = useMemo(() => new Map(categories.map((c) => [c.id, c.type])), [categories]);
  const sectionsOf = useCallback((item: MenuItem) => menuSectionsForItem(item, item.categoryId ? categoryTypeById.get(item.categoryId) : undefined), [categoryTypeById]);
  // KUHINJA is the default unless the menu has no kitchen items at all — a
  // pure-bar location should not open on a permanently empty tab.
  const [section, setSection] = useState<MenuSection>(() => (items.some((item) => sectionsOf(item).includes("KITCHEN")) ? "KITCHEN" : "BAR"));
  const sectionItems = useMemo(() => items.filter((item) => sectionsOf(item).includes(section)), [items, section, sectionsOf]);
  const sectionCategories = useMemo(() => categories.filter((c) => sectionItems.some((item) => item.categoryId === c.id)), [categories, sectionItems]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(sectionCategories[0]?.id ?? null);
  // Switching KUHINJA<->ŠANK may leave the previous category outside the new
  // section (or a mixed category simply has no items on this side) — fall
  // back to the new section's first category rather than an empty grid.
  useEffect(() => {
    if (!sectionCategories.some((c) => c.id === activeCategoryId)) setActiveCategoryId(sectionCategories[0]?.id ?? null);
  }, [sectionCategories, activeCategoryId]);
  const [search, setSearch] = useState("");
  const [resultLimit, setResultLimit] = useState(60);
  const matches = useMemo(
    () => filterMenuItems(sectionItems, search, activeCategoryId),
    [sectionItems, activeCategoryId, search]
  );
  const visibleItems = useMemo(() => search.trim() ? matches.slice(0, resultLimit) : matches, [matches, resultLimit, search]);
return (<>
        <input
          ref={searchInputRef}
          onFocus={(e) => e.currentTarget.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="m-3 h-12 w-[calc(100%-1.5rem)] rounded-md border border-line bg-white px-4 text-base shadow-sm focus:border-gold focus:outline-none"
          placeholder="Pretraga menija…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setResultLimit(60); }}
        />

        {/* Section switch stays visible during search too, so switching
            KUHINJA<->ŠANK never requires clearing an in-progress search. */}
        <SectionSwitch section={section} setSection={setSection} />

        {!search && <CategoryNavigation categories={sectionCategories} activeCategoryId={activeCategoryId} setActiveCategoryId={setActiveCategoryId} />}

        <MenuGrid visibleItems={visibleItems} submitting={submitting} handleTapMenuItem={tapMenu} />
        {visibleItems.length < matches.length && <button type="button" onClick={() => setResultLimit(limit => limit + 60)} className="mx-3 mb-3 min-h-12 w-[calc(100%-1.5rem)] rounded-md border border-line bg-white px-4 py-3 font-semibold text-gold-dark">Prikaži još · {visibleItems.length} od {matches.length}</button>}
</>);
});
