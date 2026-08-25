"use client";

import { useCallback, useEffect, useState } from "react";

// ── Normativ (recipe) — shared modal, used by both the Menu admin page's
// per-item "Normativ" button AND the dedicated Admin → Normativi page (see
// normativi-client.tsx). Reuses the existing recipe backend as-is
// (GET/POST/PATCH/DELETE .../menu/items/[id]/recipe[/lineId]) — only the
// entry form gained an optional unit selector (P1.3).

export const UNIT_LABELS_SR: Record<string, string> = { KILOGRAM: "kg", GRAM: "g", LITER: "l", MILLILITER: "ml", PIECE: "kom" };

// Which entry units are offered for a given ingredient's canonical unit —
// mirrors unit-of-measure.ts's dimension grouping (mass / volume / count).
// This list ONLY decides which options appear in the dropdown; the actual
// conversion arithmetic is authoritative server-side (convertUnit, reused
// via recipe-service.ts addRecipeLine/updateRecipeLine) — this file never
// computes the stored value itself.
const COMPATIBLE_UNITS: Record<string, string[]> = {
  KILOGRAM: ["KILOGRAM", "GRAM"],
  GRAM: ["KILOGRAM", "GRAM"],
  LITER: ["LITER", "MILLILITER"],
  MILLILITER: ["LITER", "MILLILITER"],
  PIECE: ["PIECE"],
};

// Client-side, DISPLAY-ONLY mirror of the server's canonical-unit
// conversion, used solely to show a "= 0.300 kg" live preview under the
// quantity input so the entered value is transparent before saving. Never
// used as the value actually submitted — the server independently computes
// and stores the authoritative canonical quantity.
const PREVIEW_FACTOR: Record<string, number> = { KILOGRAM: 1000, GRAM: 1, LITER: 1000, MILLILITER: 1 };
function previewCanonical(quantity: number, fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return quantity;
  if (fromUnit === "PIECE" || toUnit === "PIECE") return null;
  const inBase = quantity * (PREVIEW_FACTOR[fromUnit] ?? 1);
  return inBase / (PREVIEW_FACTOR[toUnit] ?? 1);
}

export interface IngredientOption {
  id: string;
  name: string;
  unit: string;
  isActive: boolean;
}

export interface RecipeLine {
  id: string;
  ingredientId: string;
  quantity: string;
  ingredient: IngredientOption;
}

async function recipeApiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Greška");
  return body;
}

export function RecipeModal({
  item,
  onClose,
  onChanged,
  readOnly = false,
}: {
  item: { id: string; name: string };
  onClose: () => void;
  onChanged?: () => void;
  /**
   * UX-ONLY hint — hides mutation controls for a viewer who can see the
   * recipe (menu.view) but lacks inventory.manage, so they never see an
   * "editable-looking" control that would just 403 on save. The SERVER
   * (addRecipeLine/updateRecipeLine/removeRecipeLine, all still gated by
   * requirePermission(ctx, "inventory.manage")) remains the sole real
   * authorization boundary — this prop changes nothing about what the API
   * will accept, only what this component renders.
   */
  readOnly?: boolean;
}) {
  const [lines, setLines] = useState<RecipeLine[]>([]);
  const [ingredients, setIngredients] = useState<IngredientOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingredientId, setIngredientId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [entryUnit, setEntryUnit] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recipeRes, ingRes] = await Promise.all([
        recipeApiFetch(`/api/admin/menu/items/${item.id}/recipe`),
        recipeApiFetch(`/api/admin/ingredients?activeOnly=true`),
      ]);
      setLines(recipeRes.lines ?? []);
      setIngredients(ingRes.ingredients ?? []);
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => { load(); }, [load]);

  const selectedIngredient = ingredients.find((i) => i.id === ingredientId);
  const unitOptions = selectedIngredient ? (COMPATIBLE_UNITS[selectedIngredient.unit] ?? [selectedIngredient.unit]) : [];
  const qtyNum = Number(quantity);
  const preview =
    selectedIngredient && entryUnit && Number.isFinite(qtyNum) && qtyNum > 0
      ? previewCanonical(qtyNum, entryUnit, selectedIngredient.unit)
      : null;

  function onSelectIngredient(id: string) {
    setIngredientId(id);
    const ing = ingredients.find((i) => i.id === id);
    setEntryUnit(ing?.unit ?? "");
  }

  async function addLine() {
    setErr("");
    const qty = Number(quantity);
    if (!ingredientId) { setErr("Izaberite sirovinu"); return; }
    if (!Number.isFinite(qty) || qty <= 0) { setErr("Unesite pozitivnu količinu"); return; }
    try {
      await recipeApiFetch(`/api/admin/menu/items/${item.id}/recipe`, {
        method: "POST",
        body: JSON.stringify({ ingredientId, quantity: qty, unit: entryUnit || undefined }),
      });
      setIngredientId(""); setQuantity(""); setEntryUnit("");
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Greška");
    }
  }

  // Editing an existing line stays in the ingredient's canonical unit
  // (unchanged from before P1.3) — deliberately NOT offering a unit switch
  // here, since converting an already-stored canonical value on unit-switch
  // without a confusing display round-trip is a real correctness trap (the
  // add form above avoids it by always starting from a blank, freshly-typed
  // value). Unit selection is a P1.3 addition for NEW lines only.
  async function updateLine(lineId: string, newQty: string) {
    const qty = Number(newQty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    await recipeApiFetch(`/api/admin/menu/items/${item.id}/recipe/${lineId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: qty }),
    });
    await load();
    onChanged?.();
  }

  async function removeLine(lineId: string) {
    await recipeApiFetch(`/api/admin/menu/items/${item.id}/recipe/${lineId}`, { method: "DELETE" });
    await load();
    onChanged?.();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">
            Normativ — {item.name}
            {readOnly && <span className="ml-2 align-middle text-xs font-normal text-ink/40">(samo za pregled)</span>}
          </h2>
          <button onClick={onClose} className="text-ink/50 hover:text-ink" aria-label="Zatvori">✕</button>
        </div>

        {loading ? (
          <p className="text-sm text-inkSoft">Učitavanje…</p>
        ) : lines.length === 0 ? (
          <p className="mb-3 text-sm text-inkSoft">Normativ nije definisan.</p>
        ) : (
          <table className="mb-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink/50">
                <th className="pb-1">Sirovina</th>
                <th className="pb-1">Količina</th>
                <th className="pb-1">Jedinica</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-line/60">
                  <td className="py-1.5 pr-2">{line.ingredient.name}</td>
                  <td className="py-1.5 pr-2">
                    {readOnly ? (
                      <span className="text-ink">{line.quantity}</span>
                    ) : (
                      <input
                        type="number"
                        step="0.001"
                        defaultValue={line.quantity}
                        onBlur={(e) => { if (e.target.value !== line.quantity) updateLine(line.id, e.target.value); }}
                        className="w-20 rounded-sm border border-line px-1.5 py-1 text-sm"
                      />
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-ink/60">{UNIT_LABELS_SR[line.ingredient.unit] ?? line.ingredient.unit}</td>
                  <td className="py-1.5 text-right">
                    {!readOnly && (
                      <button onClick={() => removeLine(line.id)} className="text-xs text-danger/70 hover:text-danger">Ukloni</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {readOnly ? (
          <p className="rounded-md border border-line bg-cream-100 p-3 text-xs text-inkSoft">
            Nemate dozvolu za izmenu normativa (potrebna je OWNER/ADMIN/MANAGER uloga) — prikaz je samo za pregled.
          </p>
        ) : (
          <div className="rounded-md border border-line bg-cream-100 p-3">
            <p className="mb-2 text-xs font-semibold text-ink">Dodaj sirovinu</p>
            <div className="flex flex-wrap items-start gap-2">
              <select
                className="min-w-[10rem] flex-1 rounded-sm border border-line px-2 py-1.5 text-sm"
                value={ingredientId}
                onChange={(e) => onSelectIngredient(e.target.value)}
              >
                <option value="">Sirovina…</option>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({UNIT_LABELS_SR[i.unit] ?? i.unit})</option>
                ))}
              </select>
              <input
                type="number"
                step="0.001"
                placeholder="Količina"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-24 rounded-sm border border-line px-2 py-1.5 text-sm"
              />
              {unitOptions.length > 1 ? (
                <select value={entryUnit} onChange={(e) => setEntryUnit(e.target.value)} className="rounded-sm border border-line px-2 py-1.5 text-sm">
                  {unitOptions.map((u) => <option key={u} value={u}>{UNIT_LABELS_SR[u] ?? u}</option>)}
                </select>
              ) : selectedIngredient ? (
                <span className="flex items-center px-1 text-sm text-ink/60">{UNIT_LABELS_SR[selectedIngredient.unit] ?? selectedIngredient.unit}</span>
              ) : null}
              <button onClick={addLine} className="rounded-sm bg-gold px-3 py-1.5 text-sm font-medium text-white hover:bg-gold-dark">
                Sačuvaj
              </button>
            </div>
            {preview != null && selectedIngredient && entryUnit !== selectedIngredient.unit && (
              <p className="mt-1.5 text-xs text-ink/50">
                = {preview.toFixed(3).replace(/\.?0+$/, "")} {UNIT_LABELS_SR[selectedIngredient.unit] ?? selectedIngredient.unit} (zaliha sirovine je u ovoj jedinici)
              </p>
            )}
            {err && <p className="mt-1.5 text-xs text-danger">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function RecipeButton({
  item,
  onChanged,
  readOnly = false,
}: {
  item: { id: string; name: string };
  onChanged?: () => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="text-ink/65 transition-colors hover:text-ink" title={readOnly ? "Normativ (pregled)" : "Normativ (receptura)"}>
        {readOnly ? "Normativ (pregled)" : "Normativ"}
      </button>
      {open && <RecipeModal item={item} onClose={() => setOpen(false)} onChanged={onChanged} readOnly={readOnly} />}
    </>
  );
}
