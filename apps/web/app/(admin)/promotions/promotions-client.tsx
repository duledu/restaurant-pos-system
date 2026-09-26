"use client";

import { useEffect, useState, useCallback } from "react";

interface PromotionTarget {
  id: string;
  targetType: "MENU_ITEM" | "MENU_CATEGORY";
  menuItemId: string | null;
  categoryId: string | null;
  menuItem: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
}
interface Promotion {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE";
  value: string;
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  startTime: number;
  endTime: number;
  priority: number;
  targets: PromotionTarget[];
}
interface MenuItemOption { id: string; name: string; }
interface CategoryOption { id: string; name: string; }

// Prikaz Pon..Ned, čuvanje ostaje JS Date.getDay() (0=Ned..6=Sub) — vidi
// packages/shared/promotion-schedule.ts.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABEL: Record<number, string> = { 0: "Ned", 1: "Pon", 2: "Uto", 3: "Sre", 4: "Čet", 5: "Pet", 6: "Sub" };

function minutesToTimeInput(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function timeInputToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function scheduleSummary(p: Pick<Promotion, "daysOfWeek" | "startTime" | "endTime">): string {
  const days = DAY_ORDER.filter((d) => p.daysOfWeek.includes(d)).map((d) => DAY_LABEL[d]);
  const dayText = days.length === 7 ? "Svaki dan" : days.join(", ");
  return `${dayText} · ${minutesToTimeInput(p.startTime)}–${minutesToTimeInput(p.endTime)}`;
}

function targetSummary(p: Promotion): string {
  const names = p.targets.map((t) => t.menuItem?.name ?? t.category?.name ?? "?");
  if (names.length === 0) return "—";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function valueSummary(p: Pick<Promotion, "type" | "value">): string {
  return p.type === "PERCENTAGE_DISCOUNT" ? `-${p.value}%` : `${p.value} RSD`;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function PromotionsClient() {
  const [items, setItems] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Promotion | null | "new">(null);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/promotions")
      .then((j) => setItems(j.promotions))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  async function toggleActive(p: Promotion) {
    try {
      await apiFetch(`/api/admin/promotions/${p.id}/${p.isActive ? "deactivate" : "activate"}`, { method: "POST" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => setEditing("new")}
          className="rounded-md bg-gold px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gold-dark"
        >
          + Nova promocija
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-inkSoft">Učitavanje…</p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-line bg-cream-100 p-4 text-sm text-inkSoft">Još nema kreiranih promocija.</p>
      ) : (
        <div className="space-y-2">
          {items.map((p) => (
            <div key={p.id} className="rounded-md border border-line/70 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-ink">{p.name}</h3>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                        p.isActive ? "border-info/30 bg-info-soft text-info" : "border-line bg-cream-200 text-ink/55"
                      }`}
                    >
                      {p.isActive ? "Aktivna" : "Neaktivna"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-inkSoft">{scheduleSummary(p)}</p>
                  <p className="mt-0.5 text-sm text-ink/70">{targetSummary(p)}</p>
                  <p className="mt-0.5 text-sm font-medium text-gold-dark">{valueSummary(p)}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button onClick={() => toggleActive(p)} className="rounded-md border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-cream-100">
                    {p.isActive ? "Deaktiviraj" : "Aktiviraj"}
                  </button>
                  <button onClick={() => setEditing(p)} className="rounded-md border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-cream-100">
                    Izmeni
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <PromotionModal promotion={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function PromotionModal({ promotion, onClose, onSaved }: { promotion: Promotion | null; onClose: () => void; onSaved: () => void }) {
  const isNew = promotion === null;
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [name, setName] = useState(promotion?.name ?? "");
  const [description, setDescription] = useState(promotion?.description ?? "");
  const [isActive, setIsActive] = useState(promotion?.isActive ?? true);
  const [type, setType] = useState<Promotion["type"]>(promotion?.type ?? "PERCENTAGE_DISCOUNT");
  const [value, setValue] = useState(promotion?.value ?? "20");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(promotion?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState(minutesToTimeInput(promotion?.startTime ?? 17 * 60));
  const [endTime, setEndTime] = useState(minutesToTimeInput(promotion?.endTime ?? 19 * 60));
  const [startDate, setStartDate] = useState(promotion?.startDate?.slice(0, 10) ?? "");
  const [endDate, setEndDate] = useState(promotion?.endDate?.slice(0, 10) ?? "");
  const [menuItemIds, setMenuItemIds] = useState<string[]>(promotion?.targets.filter((t) => t.targetType === "MENU_ITEM").map((t) => t.menuItemId!) ?? []);
  const [categoryIds, setCategoryIds] = useState<string[]>(promotion?.targets.filter((t) => t.targetType === "MENU_CATEGORY").map((t) => t.categoryId!) ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([apiFetch("/api/admin/menu/items?activeOnly=true"), apiFetch("/api/admin/menu/categories")])
      .then(([itemsJson, catsJson]) => {
        setMenuItems(itemsJson.items.map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })));
        setCategories(catsJson.categories.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingOptions(false));
  }, []);

  function toggleDay(day: number) {
    setDaysOfWeek((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  }
  function toggleMenuItem(id: string) {
    setMenuItemIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleCategory(id: string) {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function save() {
    setError("");
    const payload = {
      name,
      description: description || undefined,
      isActive,
      type,
      value: Number(value),
      daysOfWeek,
      startTime: timeInputToMinutes(startTime),
      endTime: timeInputToMinutes(endTime),
      startDate: startDate || null,
      endDate: endDate || null,
      priority: promotion?.priority ?? 0,
      targets: { menuItemIds, categoryIds },
    };
    setSaving(true);
    try {
      if (isNew) {
        await apiFetch("/api/admin/promotions", { method: "POST", body: JSON.stringify(payload) });
      } else {
        await apiFetch(`/api/admin/promotions/${promotion!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-elevated sm:max-w-lg sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">{isNew ? "Nova promocija" : `Izmena — ${promotion!.name}`}</h2>
            <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink/50 hover:text-ink" aria-label="Zatvori">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <label className="mb-1 block text-sm font-medium text-ink">Naziv</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Happy Hour" className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Opis (opciono)</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Status</label>
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setIsActive(true)}
              className={`rounded-md border px-3 py-2 text-sm ${isActive ? "border-info/30 bg-info-soft text-info" : "border-line text-ink/60"}`}
            >
              Aktivna
            </button>
            <button
              onClick={() => setIsActive(false)}
              className={`rounded-md border px-3 py-2 text-sm ${!isActive ? "border-line bg-cream-200 text-ink" : "border-line text-ink/60"}`}
            >
              Neaktivna
            </button>
          </div>

          <label className="mb-1 block text-sm font-medium text-ink">Važi za</label>
          {loadingOptions ? (
            <p className="mb-3 text-sm text-inkSoft">Učitavanje artikala…</p>
          ) : (
            <div className="mb-3 max-h-48 overflow-y-auto rounded-md border border-line p-2">
              <p className="mb-1 mt-1 text-xs font-semibold uppercase tracking-wide text-ink/50">Kategorije</p>
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1 text-sm text-ink">
                  <input type="checkbox" checked={categoryIds.includes(c.id)} onChange={() => toggleCategory(c.id)} />
                  {c.name}
                </label>
              ))}
              <p className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-ink/50">Artikli</p>
              {menuItems.map((i) => (
                <label key={i.id} className="flex items-center gap-2 py-1 text-sm text-ink">
                  <input type="checkbox" checked={menuItemIds.includes(i.id)} onChange={() => toggleMenuItem(i.id)} />
                  {i.name}
                </label>
              ))}
            </div>
          )}

          <label className="mb-1 block text-sm font-medium text-ink">Tip promocije</label>
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setType("PERCENTAGE_DISCOUNT")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${type === "PERCENTAGE_DISCOUNT" ? "border-gold/40 bg-gold-soft text-gold-dark" : "border-line text-ink/60"}`}
            >
              Popust %
            </button>
            <button
              onClick={() => setType("FIXED_PRICE")}
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${type === "FIXED_PRICE" ? "border-gold/40 bg-gold-soft text-gold-dark" : "border-line text-ink/60"}`}
            >
              Promo cena
            </button>
          </div>

          <label className="mb-1 block text-sm font-medium text-ink">{type === "PERCENTAGE_DISCOUNT" ? "Procenat popusta (%)" : "Promo cena (RSD)"}</label>
          <input type="number" inputMode="decimal" min={0} value={value} onChange={(e) => setValue(e.target.value)} className="mb-3 w-full rounded-md border border-line px-3 py-2 text-sm" />

          <label className="mb-1 block text-sm font-medium text-ink">Dani</label>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {DAY_ORDER.map((d) => (
              <button
                key={d}
                onClick={() => toggleDay(d)}
                className={`h-10 w-12 rounded-md border text-sm font-medium ${daysOfWeek.includes(d) ? "border-gold/40 bg-gold-soft text-gold-dark" : "border-line text-ink/60"}`}
              >
                {DAY_LABEL[d]}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-sm font-medium text-ink">Vreme</label>
          <div className="mb-3 flex items-center gap-2">
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full rounded-md border border-line px-3 py-2 text-sm" />
            <span className="text-ink/50">→</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-full rounded-md border border-line px-3 py-2 text-sm" />
          </div>
          <p className="mb-3 -mt-2 text-xs text-ink/50">Kraj pre ili jednak početku znači da termin prelazi ponoć (npr. 22:00 → 02:00).</p>

          <details className="mb-3">
            <summary className="cursor-pointer text-sm font-medium text-ink">Period važenja (opciono)</summary>
            <div className="mt-2 flex items-center gap-2">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full rounded-md border border-line px-3 py-2 text-sm" />
              <span className="text-ink/50">→</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full rounded-md border border-line px-3 py-2 text-sm" />
            </div>
          </details>

          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
        </div>

        <div className="border-t border-line px-5 py-4">
          <button
            onClick={save}
            disabled={saving || !name || daysOfWeek.length === 0}
            className="w-full rounded-md bg-gold px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gold-dark disabled:opacity-40"
          >
            {saving ? "Čuvanje…" : "Sačuvaj"}
          </button>
        </div>
      </div>
    </div>
  );
}
