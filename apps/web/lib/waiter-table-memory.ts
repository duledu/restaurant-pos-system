import { sameModifierSelection } from "./order-cart";
import type { MenuItem } from "./waiter-menu";
import type { OrderItem } from "./waiter-order-types";

export type MemorySelection = { menuItemId: string; options: string[]; quantity: number; recent: number };
const matches = (a: MemorySelection, b: MemorySelection) => a.menuItemId === b.menuItemId && sameModifierSelection(a.options.map(modifierOptionId => ({ modifierOptionId })), b.options);
function selections(lines: OrderItem[]): MemorySelection[] {
  const result: MemorySelection[] = [];
  for (const line of lines) {
    if (!line.menuItemId || line.note || line.modifiers.some(m => !m.modifierOptionId)) continue;
    const next = { menuItemId: line.menuItemId, options: line.modifiers.map(m => m.modifierOptionId!), quantity: line.quantity, recent: Date.parse(line.submittedAt ?? "") || 0 };
    const existing = result.find(value => matches(value, next));
    if (existing) { existing.quantity += next.quantity; existing.recent = Math.max(existing.recent, next.recent); }
    else result.push(next);
  }
  return result;
}
export function tableMemory(lines: OrderItem[]) {
  const history = lines.filter(line => line.status !== "DRAFT" && line.status !== "CANCELLED" && line.quantity > 0);
  const latest = Math.max(0, ...history.map(line => Date.parse(line.submittedAt ?? "") || 0));
  // Missing timestamps never invent a round. Keep invalid/deleted selections
  // in the round so repeat can report them instead of silently dropping them.
  const lastRound = latest ? history.filter(line => Date.parse(line.submittedAt ?? "") === latest) : [];
  const recent = selections(history).sort((a, b) => b.recent - a.recent || b.quantity - a.quantity || a.menuItemId.localeCompare(b.menuItemId) || [...a.options].sort().join().localeCompare([...b.options].sort().join()));
  return { recent, lastRound };
}
export function resolveQuickSelection(selection: Pick<MemorySelection, "menuItemId" | "options">, menu: MenuItem[]) {
  const item = menu.find(item => item.id === selection.menuItemId);
  if (!item || item.availability?.isAvailable !== true || item.recipeAvailability?.configured === false) return null;
  const groups = item.modifierGroups.filter(({ group }) => group.isActive);
  if (selection.options.some(id => !groups.some(({ group }) => group.options.some(option => option.id === id && option.isActive)))) return null;
  if (groups.some(({ group }) => {
    const count = group.options.filter(option => selection.options.includes(option.id)).length;
    return count < Math.max(group.minSelect, group.required ? 1 : 0) || count > group.maxSelect;
  })) return null;
  return item;
}
export function quickSuggestions(recent: MemorySelection[], favorites: MemorySelection[], menu: MenuItem[]) {
  const result: Array<MemorySelection & { source: "table" | "favorite" }> = [];
  for (const [values, source] of [[recent, "table"], [favorites, "favorite"]] as const) {
    for (const value of values) if (resolveQuickSelection(value, menu) && !result.some(previous => matches(previous, value))) {
      result.push({ ...value, source });
      if (result.length === 8) return result;
    }
  }
  return result.slice(0, 8);
}
/** Alternative inputs only: caller supplies the existing P0.4 add handler. */
export function repeatRound(lines: OrderItem[], menu: MenuItem[], add: (id: string, options: string[]) => boolean) {
  let added = 0;
  const skipped: string[] = [];
  for (const line of lines) {
    const options = line.modifiers.map(m => m.modifierOptionId!);
    if (!line.menuItemId || line.note || line.modifiers.some(m => !m.modifierOptionId) || !resolveQuickSelection({ menuItemId: line.menuItemId, options }, menu)) { skipped.push(line.name); continue; }
    for (let i = 0; i < line.quantity; i++) {
      if (add(line.menuItemId, options)) added++;
      else { skipped.push(line.name); break; }
    }
  }
  return `Ponovljeno: ${added} stavki.${skipped.length ? ` Nije moguće ponoviti: ${[...new Set(skipped)].join(", ")} — proverite dostupnost, dodatke, napomenu ili količinu.` : ""}`;
}
export function createWaiterFavorites() {
  let entries: MemorySelection[] = [];
  let revision = 0;
  return {
    record(menuItemId: string, options: string[]) {
      const next = { menuItemId, options: [...options], quantity: 1, recent: ++revision };
      const existing = entries.find(entry => matches(entry, next));
      if (existing) { existing.quantity++; existing.recent = revision; } else entries.push(next);
      entries.sort((a, b) => b.quantity - a.quantity || b.recent - a.recent);
    },
    get: () => entries.slice(0, 8),
    clear: () => { entries = []; revision = 0; },
  };
}
