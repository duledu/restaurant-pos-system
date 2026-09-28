"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { PublicMenuView, type PublicMenuPayload } from "../../m/[slug]/public-menu-view";
import { ImageUploader } from "../../../components/ui/ImageUploader";

type ThemePreset = "LIGHT" | "DARK" | "WARM" | "ELEGANT";
type TypographyPreset = "ELEGANT" | "MODERN" | "CLASSIC" | "CASUAL";
type CardStyle = "IMAGE_DOMINANT" | "BALANCED" | "COMPACT";
type ImageShape = "ROUNDED" | "SOFT" | "SQUARE";

interface Settings {
  tagline: string | null;
  coverImageUrl: string | null;
  themePreset: ThemePreset;
  accentColor: string | null;
  typographyPreset: TypographyPreset;
  cardStyle: CardStyle;
  imageShape: ImageShape;
  isPublished: boolean;
  slug: string | null;
  restaurantName: string;
  logoUrl: string | null;
}
interface PreviewItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  imageUrl: string | null;
  isActive: boolean;
  isAvailable: boolean;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
  categoryId: string | null;
}
interface PreviewCategory {
  id: string;
  name: string;
  type: "FOOD" | "DRINK";
  isActive: boolean;
}
interface TableForQr {
  id: string;
  label: string;
  publicQrToken: string | null;
}
interface FloorForQr {
  id: string;
  name: string;
  tables: TableForQr[];
}

const THEME_LABEL: Record<ThemePreset, string> = { LIGHT: "Svetla", DARK: "Tamna", WARM: "Topla", ELEGANT: "Elegantna" };
const TYPOGRAPHY_LABEL: Record<TypographyPreset, string> = { ELEGANT: "Elegantan", MODERN: "Moderan", CLASSIC: "Klasičan", CASUAL: "Opušten" };
const CARD_LABEL: Record<CardStyle, string> = { IMAGE_DOMINANT: "Velike slike", BALANCED: "Balansirano", COMPACT: "Kompaktno" };
const SHAPE_LABEL: Record<ImageShape, string> = { ROUNDED: "Zaobljeno", SOFT: "Blago zaobljeno", SQUARE: "Oštri uglovi" };

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function PresetGroup<T extends string>({ options, value, onChange, labels }: { options: readonly T[]; value: T; onChange: (v: T) => void; labels: Record<T, string> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`min-h-11 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors ${
            value === opt ? "border-gold/40 bg-gold-soft text-gold-dark" : "border-line text-ink/60 hover:bg-cream-100"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

export function QrMenuClient() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [categories, setCategories] = useState<PreviewCategory[]>([]);
  const [floors, setFloors] = useState<FloorForQr[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrPreview, setQrPreview] = useState<{ label: string; dataUrl: string; url: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, itemsRes, categoriesRes, floorsRes] = await Promise.all([
        apiFetch("/api/admin/qr-menu/settings"),
        apiFetch("/api/admin/menu/items"),
        apiFetch("/api/admin/menu/categories"),
        apiFetch("/api/admin/qr-menu/tables"),
      ]);
      setSettings(settingsRes.settings);
      setSlugInput(settingsRes.settings.slug ?? "");
      setItems(itemsRes.items);
      setCategories(categoriesRes.categories);
      setFloors(floorsRes.floors);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        tagline: settings.tagline || null,
        coverImageUrl: settings.coverImageUrl || null,
        themePreset: settings.themePreset,
        accentColor: settings.accentColor || null,
        typographyPreset: settings.typographyPreset,
        cardStyle: settings.cardStyle,
        imageShape: settings.imageShape,
        isPublished: settings.isPublished,
      };
      await apiFetch("/api/admin/qr-menu/settings", { method: "PATCH", body: JSON.stringify(payload) });
      setNotice("Sačuvano.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveSlug() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/qr-menu/slug", { method: "PATCH", body: JSON.stringify({ slug: slugInput }) });
      update("slug", res.slug);
      setNotice("Adresa menija je sačuvana.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function showTableQr(table: TableForQr) {
    setError(null);
    try {
      let token = table.publicQrToken;
      if (!token) {
        const res = await apiFetch(`/api/admin/qr-menu/tables/${table.id}/qr-token`, { method: "POST" });
        token = res.token;
        await load();
      }
      const url = `${window.location.origin}/m/${settings?.slug ?? ""}?t=${token}`;
      const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 });
      setQrPreview({ label: `Sto ${table.label}`, dataUrl, url });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function showRestaurantQr() {
    if (!settings?.slug) {
      setError("Prvo sačuvaj adresu menija.");
      return;
    }
    const url = `${window.location.origin}/m/${settings.slug}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 });
    setQrPreview({ label: "Ceo meni", dataUrl, url });
  }

  const previewMenu: PublicMenuPayload | null = useMemo(() => {
    if (!settings) return null;
    const activeCategories = categories.filter((c) => c.isActive);
    return {
      restaurant: { name: settings.restaurantName, tagline: settings.tagline, logoUrl: settings.logoUrl, coverImageUrl: settings.coverImageUrl },
      theme: { themePreset: settings.themePreset, accentColor: settings.accentColor, typographyPreset: settings.typographyPreset, cardStyle: settings.cardStyle, imageShape: settings.imageShape },
      table: null,
      categories: activeCategories
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          items: items
            .filter((i) => i.categoryId === c.id && i.isActive)
            .map((i) => ({ id: i.id, name: i.name, description: i.description, price: i.price, imageUrl: i.imageUrl, isAvailable: i.isAvailable, preparationStation: i.preparationStation })),
        }))
        .filter((c) => c.items.length > 0),
    };
  }, [settings, categories, items]);

  if (loading || !settings) return <p className="text-sm text-inkSoft">Učitavanje…</p>;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {error && <p className="rounded-md bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
        {notice && <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">{notice}</p>}

        <section className="rounded-lg border border-line/70 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink/50">Identitet</h2>
          <label className="mb-1 block text-sm font-medium text-ink">Adresa menija</label>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm text-ink/40">{typeof window !== "undefined" ? window.location.origin : ""}/m/</span>
            <input value={slugInput} onChange={(e) => setSlugInput(e.target.value)} placeholder="stari-hrast" className="min-h-11 flex-1 rounded-md border border-line px-3 py-2 text-sm" />
            <button onClick={saveSlug} disabled={saving || !slugInput.trim()} className="min-h-11 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-cream-100 disabled:opacity-40">
              Sačuvaj
            </button>
          </div>
          <p className="mb-4 text-xs text-ink/45">Samo mala slova, brojevi i crtice. Ovo je javna adresa gostiju.</p>

          <label className="mb-1 block text-sm font-medium text-ink">Slogan (opciono)</label>
          <input value={settings.tagline ?? ""} onChange={(e) => update("tagline", e.target.value || null)} placeholder="Ukusi koje pamtite" className="min-h-11 w-full rounded-md border border-line px-3 py-2 text-sm" />
        </section>

        {/* IMAGE MANAGEMENT V1 — real upload, not a URL field; the same
            RestaurantSettings.logoUrl the public menu already reads (single
            source of truth, no QR-only duplicate) is now directly editable
            here so the owner doesn't need to find /settings/restaurant. */}
        <section className="rounded-lg border border-line/70 bg-white p-5">
          <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-ink/50">Brendiranje</h2>
          <div className="mb-5">
            <ImageUploader
              label="Logo restorana"
              shape="circle"
              value={settings.logoUrl}
              uploadUrl="/api/admin/uploads/logo"
              onUploaded={(url) => update("logoUrl", url)}
              onRemoved={() => update("logoUrl", null)}
            />
          </div>
          <div>
            <ImageUploader
              label="Naslovna fotografija"
              shape="wide"
              value={settings.coverImageUrl}
              uploadUrl="/api/admin/uploads/qr-hero"
              onUploaded={(url) => update("coverImageUrl", url)}
              onRemoved={() => update("coverImageUrl", null)}
            />
            <p className="mt-2 text-xs text-ink/45">Kada je postavljena, ova fotografija dominira vrhom javnog menija. Bez nje se prikazuje dekorativni obrazac.</p>
          </div>
        </section>

        <section className="rounded-lg border border-line/70 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink/50">Izgled</h2>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={settings.isPublished} onChange={(e) => update("isPublished", e.target.checked)} />
              Meni je javno dostupan
            </label>
          </div>

          <p className="mb-1.5 text-sm font-medium text-ink">Tema</p>
          <PresetGroup options={["LIGHT", "DARK", "WARM", "ELEGANT"] as const} value={settings.themePreset} onChange={(v) => update("themePreset", v)} labels={THEME_LABEL} />

          <p className="mb-1.5 mt-4 text-sm font-medium text-ink">Akcentna boja (opciono)</p>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={settings.accentColor ?? "#B8860B"}
              onChange={(e) => update("accentColor", e.target.value)}
              className="h-11 w-14 cursor-pointer rounded-md border border-line"
            />
            <input
              value={settings.accentColor ?? ""}
              onChange={(e) => update("accentColor", e.target.value || null)}
              placeholder="Podrazumevano iz teme"
              className="min-h-11 flex-1 rounded-md border border-line px-3 py-2 text-sm"
            />
            {settings.accentColor && (
              <button onClick={() => update("accentColor", null)} className="min-h-11 rounded-md border border-line px-3 text-xs font-medium text-ink/60 hover:bg-cream-100">
                Resetuj
              </button>
            )}
          </div>

          <p className="mb-1.5 mt-4 text-sm font-medium text-ink">Tipografija</p>
          <PresetGroup options={["ELEGANT", "MODERN", "CLASSIC", "CASUAL"] as const} value={settings.typographyPreset} onChange={(v) => update("typographyPreset", v)} labels={TYPOGRAPHY_LABEL} />

          <p className="mb-1.5 mt-4 text-sm font-medium text-ink">Stil kartica</p>
          <PresetGroup options={["IMAGE_DOMINANT", "BALANCED", "COMPACT"] as const} value={settings.cardStyle} onChange={(v) => update("cardStyle", v)} labels={CARD_LABEL} />

          <p className="mb-1.5 mt-4 text-sm font-medium text-ink">Oblik slika</p>
          <PresetGroup options={["ROUNDED", "SOFT", "SQUARE"] as const} value={settings.imageShape} onChange={(v) => update("imageShape", v)} labels={SHAPE_LABEL} />

          <button onClick={saveSettings} disabled={saving} className="mt-5 w-full rounded-md bg-gold px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-gold-dark disabled:opacity-40 sm:w-auto">
            {saving ? "Čuvanje…" : "Sačuvaj izgled"}
          </button>
        </section>

        <section className="rounded-lg border border-line/70 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink/50">QR kodovi</h2>
          <button onClick={showRestaurantQr} className="mb-4 min-h-11 rounded-md border border-gold/40 bg-gold-soft px-3.5 py-2 text-sm font-semibold text-gold-dark hover:border-gold/60">
            QR za ceo meni
          </button>
          {floors.map((floor) => (
            <div key={floor.id} className="mb-3">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink/45">{floor.name}</p>
              <div className="flex flex-wrap gap-2">
                {floor.tables.map((t) => (
                  <button key={t.id} onClick={() => showTableQr(t)} className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-cream-100">
                    Sto {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>

      {/* ── Pregled — SAME component/theme engine as the public menu, never a duplicate (spec section 8) ── */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink/50">Mobilni pregled</h2>
        <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-[2rem] border-8 border-ink/80 bg-black shadow-elevated">
          <div className="h-[680px] overflow-y-auto">{previewMenu && <PublicMenuView menu={previewMenu} />}</div>
        </div>
      </div>

      {qrPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setQrPreview(null)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setQrPreview(null); } }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div className="w-full max-w-xs rounded-lg bg-white p-5 text-center shadow-elevated" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-bold text-ink">{qrPreview.label}</h3>
            {/* eslint-disable-next-line @next/next/no-img-element -- locally-generated data: URL, next/image doesn't apply */}
            <img src={qrPreview.dataUrl} alt={`QR kod — ${qrPreview.label}`} className="mx-auto mb-3 h-56 w-56" />
            <p className="mb-3 break-all text-xs text-ink/50">{qrPreview.url}</p>
            <a href={qrPreview.dataUrl} download={`qr-${qrPreview.label.replace(/\s+/g, "-").toLowerCase()}.png`} className="mb-2 block min-h-11 rounded-md bg-gold px-4 py-2.5 text-sm font-bold leading-[2.5] text-white hover:bg-gold-dark">
              Preuzmi
            </a>
            <button onClick={() => setQrPreview(null)} autoFocus className="min-h-11 w-full rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-cream-100">
              Zatvori
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
