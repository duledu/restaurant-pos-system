"use client";

import { useEffect, useState, useCallback, useMemo } from "react";

interface Category {
  id: string;
  name: string;
  slug: string;
  type: "FOOD" | "DRINK";
  sortOrder: number;
  isActive: boolean;
}

interface MenuItem {
  id: string;
  name: string;
  slug: string;
  price: string;
  quantity: string | null;
  unit: string | null;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
  isActive: boolean;
  isAvailable: boolean;
  needsReview: boolean;
  reviewNote: string | null;
  category: Category | null;
  categoryId: string | null;
}

const STATION_LABEL: Record<MenuItem["preparationStation"], string> = {
  KITCHEN: "Kuhinja",
  BAR: "Šank",
  KITCHEN_AND_BAR: "Kuhinja + Šank",
  NONE: "—",
};

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function MenuManagementClient() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<"" | "FOOD" | "DRINK">("");
  const [stationFilter, setStationFilter] = useState<"" | MenuItem["preparationStation"]>("");
  const [showHidden, setShowHidden] = useState(true);

  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryFilter) params.set("categoryId", categoryFilter);
      if (typeFilter) params.set("type", typeFilter);
      if (stationFilter) params.set("station", stationFilter);

      const [itemsRes, categoriesRes] = await Promise.all([
        apiFetch(`/api/admin/menu/items?${params.toString()}`),
        apiFetch(`/api/admin/menu/categories`),
      ]);
      setItems(itemsRes.items);
      setCategories(categoriesRes.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Neočekivana greška");
    } finally {
      setLoading(false);
    }
  }, [search, categoryFilter, typeFilter, stationFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const visibleItems = useMemo(
    () => (showHidden ? items : items.filter((i) => i.isActive)),
    [items, showHidden]
  );

  async function savePrice(id: string) {
    const price = Number(priceDraft);
    if (Number.isNaN(price) || price < 0) {
      setError("Neispravna cena");
      return;
    }
    try {
      await apiFetch(`/api/admin/menu/items/${id}/price`, {
        method: "POST",
        body: JSON.stringify({ price }),
      });
      setEditingPriceId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri izmeni cene");
    }
  }

  async function toggleActive(item: MenuItem) {
    try {
      await apiFetch(`/api/admin/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function toggleAvailable(item: MenuItem) {
    try {
      await apiFetch(`/api/admin/menu/items/${item.id}/availability`, {
        method: "POST",
        body: JSON.stringify({ isAvailable: !item.isAvailable }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function duplicateItem(id: string) {
    try {
      await apiFetch(`/api/admin/menu/items/${id}/duplicate`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function archiveItem(id: string) {
    if (!confirm("Arhiviraj artikal? Neće se više prikazivati, ali istorija porudžbina ostaje netaknuta.")) return;
    try {
      await apiFetch(`/api/admin/menu/items/${id}/archive`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function deleteItem(id: string) {
    if (!confirm("Trajno obriši artikal? Ova akcija se ne može poništiti.")) return;
    try {
      await apiFetch(`/api/admin/menu/items/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  async function moveToCategory(id: string, categoryId: string) {
    try {
      await apiFetch(`/api/admin/menu/items/${id}/category`, {
        method: "POST",
        body: JSON.stringify({ categoryId: categoryId || null }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    }
  }

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger/5 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Filteri */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-line bg-white p-3">
        <input
          className="w-56 rounded-sm border border-line px-3 py-1.5 text-sm"
          placeholder="Pretraga po nazivu…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="rounded-sm border border-line px-2 py-1.5 text-sm"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">Sve kategorije</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-sm border border-line px-2 py-1.5 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
        >
          <option value="">Hrana / Piće</option>
          <option value="FOOD">Hrana</option>
          <option value="DRINK">Piće</option>
        </select>
        <select
          className="rounded-sm border border-line px-2 py-1.5 text-sm"
          value={stationFilter}
          onChange={(e) => setStationFilter(e.target.value as typeof stationFilter)}
        >
          <option value="">Kuhinja / Šank</option>
          <option value="KITCHEN">Kuhinja</option>
          <option value="BAR">Šank</option>
          <option value="KITCHEN_AND_BAR">Kuhinja + Šank</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-ink/70">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Prikaži skrivene
        </label>
        <div className="ml-auto">
          <button
            onClick={() => setShowAddForm(true)}
            className="rounded-sm bg-graphite px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            + Dodaj artikal
          </button>
        </div>
      </div>

      {showAddForm && (
        <AddItemForm
          categories={categories}
          onClose={() => setShowAddForm(false)}
          onCreated={async () => {
            setShowAddForm(false);
            await load();
          }}
          setError={setError}
        />
      )}

      {/* Tabela */}
      <div className="overflow-hidden rounded-md border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-ink/[0.02] text-left text-xs uppercase tracking-wide text-ink/50">
              <th className="px-4 py-2 font-medium">Naziv</th>
              <th className="px-4 py-2 font-medium">Kategorija</th>
              <th className="px-4 py-2 font-medium">Cena</th>
              <th className="px-4 py-2 font-medium">Težina/Zapremina</th>
              <th className="px-4 py-2 font-medium">Stanica</th>
              <th className="px-4 py-2 font-medium">Dostupno</th>
              <th className="px-4 py-2 font-medium">Aktivno</th>
              <th className="px-4 py-2 font-medium">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-ink/40">
                  Učitavanje…
                </td>
              </tr>
            )}
            {!loading && visibleItems.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-ink/40">
                  Nema artikala za ove filtere.
                </td>
              </tr>
            )}
            {visibleItems.map((item) => (
              <tr key={item.id} className="border-b border-line last:border-0 hover:bg-ink/[0.015]">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-ink">{item.name}</div>
                  {item.needsReview && (
                    <span className="mt-0.5 inline-block rounded-sm bg-warnSoft px-1.5 py-0.5 text-xs font-medium text-warn">
                      Cena zahteva potvrdu
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <select
                    className="rounded-sm border border-line bg-transparent px-1.5 py-1 text-xs"
                    value={item.categoryId ?? ""}
                    onChange={(e) => moveToCategory(item.id, e.target.value)}
                  >
                    <option value="">Nekategorisano</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  {editingPriceId === item.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        className="w-20 rounded-sm border border-line px-1.5 py-1 text-xs"
                        value={priceDraft}
                        onChange={(e) => setPriceDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && savePrice(item.id)}
                      />
                      <button onClick={() => savePrice(item.id)} className="text-xs font-medium text-gold-dark">
                        Sačuvaj
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingPriceId(item.id);
                        setPriceDraft(item.price);
                      }}
                      className="rounded-sm px-1.5 py-1 text-left hover:bg-gold-soft"
                    >
                      {Number(item.price).toFixed(2)} RSD
                    </button>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink/70">
                  {item.quantity ? `${item.quantity} ${item.unit ?? ""}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-ink/70">{STATION_LABEL[item.preparationStation]}</td>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={item.isAvailable} onChange={() => toggleAvailable(item)} />
                </td>
                <td className="px-4 py-2.5">
                  <input type="checkbox" checked={item.isActive} onChange={() => toggleActive(item)} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => duplicateItem(item.id)} className="text-ink/60 hover:text-ink">
                      Kopiraj
                    </button>
                    <button onClick={() => archiveItem(item.id)} className="text-ink/60 hover:text-ink">
                      Arhiviraj
                    </button>
                    <button onClick={() => deleteItem(item.id)} className="text-danger/70 hover:text-danger">
                      Obriši
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddItemForm({
  categories,
  onClose,
  onCreated,
  setError,
}: {
  categories: Category[];
  onClose: () => void;
  onCreated: () => Promise<void>;
  setError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [station, setStation] = useState<MenuItem["preparationStation"]>("KITCHEN");
  const [saving, setSaving] = useState(false);

  function slugify(input: string) {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9čćšžđ\s-]/g, "")
      .replace(/[čć]/g, "c")
      .replace(/š/g, "s")
      .replace(/ž/g, "z")
      .replace(/đ/g, "dj")
      .replace(/\s+/g, "-");
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/menu/items`, {
        method: "POST",
        body: JSON.stringify({
          name,
          slug: slugify(name),
          price: Number(price),
          categoryId: categoryId || null,
          preparationStation: station,
        }),
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju artikla");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-ink/20" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-md border border-line bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-ink">Novi artikal</h2>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/60">Naziv</label>
            <input
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/60">Cena (RSD)</label>
            <input
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/60">Kategorija</label>
            <select
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Nekategorisano</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink/60">Stanica</label>
            <select
              className="w-full rounded-sm border border-line px-3 py-1.5 text-sm"
              value={station}
              onChange={(e) => setStation(e.target.value as MenuItem["preparationStation"])}
            >
              <option value="KITCHEN">Kuhinja</option>
              <option value="BAR">Šank</option>
              <option value="KITCHEN_AND_BAR">Kuhinja + Šank</option>
              <option value="NONE">—</option>
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-sm px-3 py-1.5 text-sm text-ink/60 hover:bg-ink/5">
            Otkaži
          </button>
          <button
            onClick={submit}
            disabled={saving || !name || !price}
            className="rounded-sm bg-graphite px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Čuvanje…" : "Sačuvaj"}
          </button>
        </div>
      </div>
    </div>
  );
}
