"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../components/ui/LogoutButton";
import { QuickLockButton } from "../../../../components/ui/QuickLockButton";
import { VOID_REASON_CODES, VOID_REASON_LABELS, isMeaningfulVoidExplanation, type VoidReasonCode } from "@rcs/shared";

interface Category {
  id: string;
  name: string;
  type: "FOOD" | "DRINK";
}
interface MenuItem {
  id: string;
  name: string;
  price: string;
  categoryId: string | null;
}
interface OrderItem {
  id: string;
  menuItemId: string | null;
  name: string;
  price: string;
  quantity: number;
  note: string | null;
  status: "DRAFT" | "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
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

      const [orderDetail, categoriesRes, itemsRes, meRes] = await Promise.all([
        apiFetch(`/api/pos/orders/${orderId}`),
        apiFetch(`/api/admin/menu/categories`),
        apiFetch(`/api/admin/menu/items?activeOnly=true`),
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

  async function addItem(menuItemId: string) {
    if (!order) return;
    setError(null);
    await withCartLock(async () => {
      // Ako artikal već postoji kao DRAFT stavka na ovoj porudžbini, ponovni
      // tap povećava postojeći red umesto da pravi novi (max 50, isto
      // ograničenje kao addOrderItemSchema) — koristi VEĆ POSTOJEĆI PATCH
      // endpoint (updateOrderItemSchema.quantity), bez promene modela
      // podataka ili logike odbitka zaliha (ta i dalje čita order.items u
      // trenutku naplate, kakvi god redovi da postoje).
      const existing = order.items.find((i) => i.menuItemId === menuItemId);
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
            body: JSON.stringify({ menuItemId, quantity: 1 }),
          });
        }
        const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
        setOrder(refreshed.order);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Greška pri dodavanju artikla");
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
          {visibleItems.map((item) => (
            <button
              key={item.id}
              onClick={() => addItem(item.id)}
              disabled={cartBusy}
              className="flex min-h-[104px] flex-col justify-between rounded-lg border border-line bg-white p-4 text-left shadow-sm transition-all active:translate-y-px active:scale-[.98] disabled:opacity-60 sm:hover:border-gold/60 sm:hover:shadow-card"
            >
              <div className="font-semibold leading-snug text-ink">{item.name}</div>
              <div className="mt-3 text-base font-bold tabular-nums text-gold-dark">{Number(item.price).toFixed(2)} <span className="text-[10px] font-semibold text-inkSoft">RSD</span></div>
            </button>
          ))}
          {visibleItems.length === 0 && <div className="col-span-full py-8 text-center text-ink/55">Nema artikala.</div>}
        </div>
      </div>

      {/* Sticky pregled porudžbine */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-line bg-white shadow-[0_-12px_32px_rgba(10,25,49,.12)]">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between border-b border-line/70 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-inkSoft">Tekuća porudžbina</p><span className="rounded-md bg-ink/[.06] px-2 py-1 text-xs font-semibold tabular-nums">{order.items.reduce((n, item) => n + item.quantity, 0)} stavki</span></div>
        <div className="mx-auto max-h-36 w-full max-w-5xl overflow-y-auto px-3 py-2">
          {order.items.length === 0 && <div className="py-2 text-center text-sm text-ink/55">Nema stavki još.</div>}
          {order.items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 border-b border-line/50 py-2 text-sm last:border-0">
              <span className="min-w-0 flex-1 truncate text-ink" title={item.name}>
                {item.name}
              </span>
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
          ))}
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
    </div>
  );
}
