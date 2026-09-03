"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { PageHeader } from "../../../../components/ui/PageHeader";

interface ModifierOption {
  id: string;
  name: string;
  priceDelta: string;
  sortOrder: number;
  isActive: boolean;
}
interface ModifierGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  isActive: boolean;
  options: ModifierOption[];
  menuItems: { menuItem: { id: string; name: string } }[];
}
interface MenuItemOption {
  id: string;
  name: string;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function ModifiersManagementClient() {
  const [groups, setGroups] = useState<ModifierGroup[] | null>(null);
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [groupsRes, itemsRes] = await Promise.all([
        apiFetch("/api/admin/menu/modifier-groups"),
        apiFetch("/api/admin/menu/items?activeOnly=true"),
      ]);
      setGroups(groupsRes.groups);
      setMenuItems(itemsRes.items.map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createGroup() {
    if (!newGroupName.trim() || creating) return;
    setCreating(true);
    try {
      await apiFetch("/api/admin/menu/modifier-groups", {
        method: "POST",
        body: JSON.stringify({ name: newGroupName.trim(), required: false, minSelect: 0, maxSelect: 1 }),
      });
      setNewGroupName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju grupe");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Dodaci i modifikatori"
        description="Grupe dodataka (npr. Veličina, Dodaci) i njihove opcije — mogu se vezati za više artikala menija."
      />

      {error && <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className="mb-1.5 block text-sm font-medium text-inkSoft">Nova grupa dodataka</label>
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="npr. Dodaci, Veličina, Prilozi"
              className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
              onKeyDown={(e) => e.key === "Enter" && createGroup()}
            />
          </div>
          <button
            onClick={createGroup}
            disabled={creating || !newGroupName.trim()}
            className="min-h-11 rounded-md bg-graphite px-5 py-2.5 text-sm font-semibold text-cream-100 disabled:opacity-40"
          >
            {creating ? "Dodavanje…" : "Dodaj grupu"}
          </button>
        </div>
      </Card>

      {!groups ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState title="Nema definisanih grupa dodataka." description="Kreiraj prvu grupu iznad." />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <ModifierGroupCard key={group.id} group={group} menuItems={menuItems} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModifierGroupCard({
  group,
  menuItems,
  onChanged,
}: {
  group: ModifierGroup;
  menuItems: MenuItemOption[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newOptionName, setNewOptionName] = useState("");
  const [newOptionPrice, setNewOptionPrice] = useState("0");
  const [attachItemId, setAttachItemId] = useState("");

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusy(false);
    }
  }

  const attachedIds = new Set(group.menuItems.map((m) => m.menuItem.id));
  const attachableItems = menuItems.filter((i) => !attachedIds.has(i.id));

  return (
    <Card className={`p-4 ${!group.isActive ? "opacity-60" : ""}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-ink">{group.name}</h2>
          {group.required ? <Badge tone="gold">Obavezno</Badge> : <Badge tone="neutral">Opciono</Badge>}
          <Badge tone="neutral">
            {group.minSelect}–{group.maxSelect} izbora
          </Badge>
          {!group.isActive && <Badge tone="danger">Neaktivno</Badge>}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-inkSoft">
            <input
              type="checkbox"
              checked={group.required}
              disabled={busy}
              onChange={(e) => run(() => apiFetch(`/api/admin/menu/modifier-groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ required: e.target.checked }) }))}
              className="accent-gold"
            />
            Obavezno
          </label>
          <label className="flex items-center gap-1 text-inkSoft">
            min
            <input
              type="number"
              min={0}
              value={group.minSelect}
              disabled={busy}
              onChange={(e) => run(() => apiFetch(`/api/admin/menu/modifier-groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ minSelect: Number(e.target.value) }) }))}
              className="w-14 rounded-sm border border-line px-1.5 py-1"
            />
          </label>
          <label className="flex items-center gap-1 text-inkSoft">
            max
            <input
              type="number"
              min={1}
              value={group.maxSelect}
              disabled={busy}
              onChange={(e) => run(() => apiFetch(`/api/admin/menu/modifier-groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ maxSelect: Number(e.target.value) }) }))}
              className="w-14 rounded-sm border border-line px-1.5 py-1"
            />
          </label>
          <button
            disabled={busy}
            onClick={() => run(() => apiFetch(`/api/admin/menu/modifier-groups/${group.id}/active`, { method: "POST", body: JSON.stringify({ isActive: !group.isActive }) }))}
            className="text-ink/65 underline hover:text-ink"
          >
            {group.isActive ? "Deaktiviraj" : "Aktiviraj"}
          </button>
        </div>
      </div>

      {error && <div className="mb-2 rounded-sm bg-danger-soft px-2 py-1 text-xs text-danger">{error}</div>}

      {/* Opcije */}
      <div className="mb-3 divide-y divide-line rounded-md border border-line">
        {group.options.length === 0 && <p className="p-3 text-xs text-inkSoft">Nema opcija još.</p>}
        {group.options.map((option) => (
          <div key={option.id} className={`flex items-center gap-2 p-2.5 text-sm ${!option.isActive ? "opacity-50" : ""}`}>
            <span className="min-w-0 flex-1 truncate text-ink">{option.name}</span>
            <input
              type="number"
              step="0.01"
              defaultValue={option.priceDelta}
              disabled={busy}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v) && v !== Number(option.priceDelta)) {
                  run(() => apiFetch(`/api/admin/menu/modifier-options/${option.id}`, { method: "PATCH", body: JSON.stringify({ priceDelta: v }) }));
                }
              }}
              className="w-24 rounded-sm border border-line px-2 py-1 text-right tabular-nums"
            />
            <span className="text-xs text-inkSoft">RSD</span>
            <button
              disabled={busy}
              onClick={() => run(() => apiFetch(`/api/admin/menu/modifier-options/${option.id}/active`, { method: "POST", body: JSON.stringify({ isActive: !option.isActive }) }))}
              className="text-xs text-ink/60 underline hover:text-ink"
            >
              {option.isActive ? "Deaktiviraj" : "Aktiviraj"}
            </button>
          </div>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <input
          value={newOptionName}
          onChange={(e) => setNewOptionName(e.target.value)}
          placeholder="Naziv opcije (npr. Kačkavalj)"
          className="min-w-[160px] flex-1 rounded-sm border border-line px-2.5 py-1.5 text-sm"
        />
        <input
          type="number"
          step="0.01"
          value={newOptionPrice}
          onChange={(e) => setNewOptionPrice(e.target.value)}
          className="w-24 rounded-sm border border-line px-2.5 py-1.5 text-sm text-right tabular-nums"
        />
        <button
          disabled={busy || !newOptionName.trim()}
          onClick={() =>
            run(async () => {
              await apiFetch(`/api/admin/menu/modifier-groups/${group.id}/options`, {
                method: "POST",
                body: JSON.stringify({ name: newOptionName.trim(), priceDelta: Number(newOptionPrice) || 0 }),
              });
              setNewOptionName("");
              setNewOptionPrice("0");
            })
          }
          className="min-h-9 rounded-sm bg-gold px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Dodaj opciju
        </button>
      </div>

      {/* Vezani artikli */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-inkSoft">Vezano za artikle</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {group.menuItems.length === 0 && <span className="text-xs text-inkSoft">Nije vezano ni za jedan artikal.</span>}
          {group.menuItems.map(({ menuItem }) => (
            <span key={menuItem.id} className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 py-1 text-xs text-ink">
              {menuItem.name}
              <button
                disabled={busy}
                onClick={() => run(() => apiFetch(`/api/admin/menu/items/${menuItem.id}/modifier-groups/${group.id}`, { method: "DELETE" }))}
                className="text-ink/50 hover:text-danger"
                aria-label={`Ukloni vezu sa ${menuItem.name}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={attachItemId}
            onChange={(e) => setAttachItemId(e.target.value)}
            className="rounded-sm border border-line px-2 py-1.5 text-xs"
          >
            <option value="">Izaberi artikal…</option>
            {attachableItems.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
          <button
            disabled={busy || !attachItemId}
            onClick={() =>
              run(async () => {
                await apiFetch(`/api/admin/menu/items/${attachItemId}/modifier-groups`, {
                  method: "POST",
                  body: JSON.stringify({ modifierGroupId: group.id }),
                });
                setAttachItemId("");
              })
            }
            className="min-h-9 rounded-sm border border-line px-3 py-1.5 text-xs font-medium text-ink hover:border-gold/50 disabled:opacity-40"
          >
            Veži za artikal
          </button>
        </div>
      </div>
    </Card>
  );
}
