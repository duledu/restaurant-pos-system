"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogoutButton } from "../../../../components/ui/LogoutButton";

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

      const [orderDetail, categoriesRes, itemsRes] = await Promise.all([
        apiFetch(`/api/pos/orders/${orderId}`),
        apiFetch(`/api/admin/menu/categories`),
        apiFetch(`/api/admin/menu/items?activeOnly=true`),
      ]);

      setOrder(orderDetail.order);
      setCategories(categoriesRes.categories);
      setItems(itemsRes.items);
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

  async function addItem(menuItemId: string) {
    if (!order) return;
    setError(null);
    try {
      await apiFetch(`/api/pos/orders/${order.id}/items`, {
        method: "POST",
        body: JSON.stringify({ menuItemId, quantity: 1 }),
      });
      const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
      setOrder(refreshed.order);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri dodavanju artikla");
    }
  }

  async function removeItem(itemId: string) {
    if (!order) return;
    try {
      await apiFetch(`/api/pos/orders/${order.id}/items/${itemId}`, { method: "DELETE" });
      const refreshed = await apiFetch(`/api/pos/orders/${order.id}`);
      setOrder(refreshed.order);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
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
          <button onClick={() => router.push("/waiter/tables")} className="text-sm font-medium text-gold-dark">
            ← Stolovi
          </button>
          <h1 className="text-lg font-semibold text-ink">{order.table.label}</h1>
          <LogoutButton />
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
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${ITEM_STATUS_TONE[item.status]}`}>
                {ITEM_STATUS_LABEL[item.status]}
              </span>
            </div>
          ))}
        </div>

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
    <div className="flex min-h-screen flex-col pb-40">
      <div className="border-b border-line bg-white p-3">
        <button onClick={() => router.push("/waiter/tables")} className="text-sm font-medium text-gold-dark">
          ← Stolovi
        </button>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-ink">{order.table.label}</h1>
          <LogoutButton />
        </div>
      </div>

      {error && <div className="mx-3 mt-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}

      <input
        className="m-3 rounded-md border border-line px-4 py-3 text-base"
        placeholder="Pretraga menija…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {!search && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-2">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategoryId(c.id)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${
                activeCategoryId === c.id ? "bg-gold text-white" : "bg-white text-ink/75 border border-line"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            onClick={() => addItem(item.id)}
            className="rounded-md border border-line bg-white p-4 text-left shadow-sm active:scale-95"
          >
            <div className="font-medium text-ink">{item.name}</div>
            <div className="text-sm text-ink/65">{Number(item.price).toFixed(2)} RSD</div>
          </button>
        ))}
        {visibleItems.length === 0 && <div className="col-span-full py-8 text-center text-ink/55">Nema artikala.</div>}
      </div>

      {/* Sticky pregled porudžbine */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-line bg-white shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
        <div className="max-h-40 overflow-y-auto px-3 py-2">
          {order.items.length === 0 && <div className="py-2 text-center text-sm text-ink/55">Nema stavki još.</div>}
          {order.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between py-1 text-sm">
              <span className="text-ink">
                {item.quantity}× {item.name}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-ink/70">{(Number(item.price) * item.quantity).toFixed(2)} RSD</span>
                <button onClick={() => removeItem(item.id)} className="text-danger/60 text-xs">
                  Ukloni
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line px-3 py-2">
          <span className="text-base font-semibold text-ink">Ukupno: {total.toFixed(2)} RSD</span>
        </div>
        <button
          onClick={submit}
          disabled={submitting || order.items.length === 0}
          className="w-full bg-graphite py-4 text-lg font-semibold text-cream-100 disabled:opacity-40 transition-colors hover:bg-graphite-700"
        >
          {submitting ? "Slanje…" : "Pošalji porudžbinu"}
        </button>
      </div>
    </div>
  );
}
