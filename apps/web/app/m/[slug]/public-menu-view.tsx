"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Playfair_Display, Inter, Outfit, Work_Sans, Cormorant_Garamond, Libre_Baskerville, Fredoka, Nunito } from "next/font/google";
import { resolveQrMenuTheme, type QrThemePreset, type QrTypographyPreset, type QrCardStyle, type QrImageShape } from "@rcs/shared";

// ── BRANDED QR MENU V1 — guest-facing design system ─────────────────────
//
// Deliberately its OWN visual language, not a reskin of TableCore's
// internal Admin/Waiter UI (spec section 2) — this file never imports
// TableCore's internal component library. Theming is 100% data-driven
// (CSS custom properties resolved from QrMenuSettings via
// resolveQrMenuTheme) so the SAME components/markup render every
// restaurant differently — no restaurant-specific forks (spec section 5).

const playfair = Playfair_Display({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-elegant-heading" });
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-elegant-body" });
const outfit = Outfit({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-modern-heading" });
const workSans = Work_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-modern-body" });
const cormorant = Cormorant_Garamond({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-classic-heading" });
const libreBaskerville = Libre_Baskerville({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-classic-body" });
const fredoka = Fredoka({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-casual-heading" });
const nunito = Nunito({ subsets: ["latin", "latin-ext"], variable: "--font-casual-body" });

const FONT_VARIABLES = [playfair, inter, outfit, workSans, cormorant, libreBaskerville, fredoka, nunito].map((f) => f.variable).join(" ");

const TYPOGRAPHY_FONT_VARS: Record<QrTypographyPreset, { heading: string; body: string }> = {
  ELEGANT: { heading: "var(--font-elegant-heading)", body: "var(--font-elegant-body)" },
  MODERN: { heading: "var(--font-modern-heading)", body: "var(--font-modern-body)" },
  CLASSIC: { heading: "var(--font-classic-heading)", body: "var(--font-classic-body)" },
  CASUAL: { heading: "var(--font-casual-heading)", body: "var(--font-casual-body)" },
};

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  imageUrl: string | null;
  isAvailable: boolean;
}
export interface PublicMenuCategory {
  id: string;
  name: string;
  items: PublicMenuItem[];
}
export interface PublicMenuPayload {
  restaurant: { name: string; tagline: string | null; logoUrl: string | null; coverImageUrl: string | null };
  theme: { themePreset: QrThemePreset; accentColor: string | null; typographyPreset: QrTypographyPreset; cardStyle: QrCardStyle; imageShape: QrImageShape };
  table: { label: string } | null;
  categories: PublicMenuCategory[];
}

function formatPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n)) return price;
  return new Intl.NumberFormat("sr-RS", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
}

/** Elegant fallback for a product with no photo — a monogram tile in the accent tint, never a broken-image icon (spec section 18/19). */
function NoImageTile({ name, shapeClass }: { name: string; shapeClass: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={`flex h-full w-full items-center justify-center ${shapeClass}`}
      style={{ background: "color-mix(in srgb, var(--menu-primary) 12%, var(--menu-surface))" }}
      aria-hidden="true"
    >
      <span className="text-2xl font-semibold" style={{ color: "var(--menu-primary)", fontFamily: "var(--menu-font-heading)" }}>
        {initial}
      </span>
    </div>
  );
}

const IMAGE_SHAPE_CLASS: Record<QrImageShape, string> = {
  ROUNDED: "rounded-2xl",
  SOFT: "rounded-lg",
  SQUARE: "rounded-sm",
};

function ProductCard({ item, cardStyle, imageShape, onOpen }: { item: PublicMenuItem; cardStyle: QrCardStyle; imageShape: QrImageShape; onOpen: () => void }) {
  const shapeClass = IMAGE_SHAPE_CLASS[imageShape];
  const imageAspect = cardStyle === "IMAGE_DOMINANT" ? "aspect-[4/3]" : cardStyle === "COMPACT" ? "aspect-square" : "aspect-[5/4]";
  const imageWrapperSize = cardStyle === "COMPACT" ? "w-20 shrink-0" : "w-full";
  const isCompact = cardStyle === "COMPACT";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex min-h-11 w-full overflow-hidden border text-left transition-transform active:scale-[.98] ${isCompact ? "flex-row items-center gap-3 p-2.5" : "flex-col gap-0"} ${shapeClass}`}
      style={{ background: "var(--menu-surface)", borderColor: "var(--menu-border)" }}
    >
      <div className={`relative overflow-hidden ${imageWrapperSize} ${isCompact ? "h-20" : imageAspect} ${shapeClass}`}>
        {item.imageUrl ? (
          <Image src={item.imageUrl} alt="" fill sizes="(max-width: 640px) 50vw, 300px" className="object-cover" />
        ) : (
          <NoImageTile name={item.name} shapeClass="" />
        )}
        {!item.isAvailable && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/45">
            <span className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white">Trenutno nije dostupno</span>
          </div>
        )}
      </div>
      <div className={`flex flex-1 flex-col gap-1 ${isCompact ? "" : "p-3.5"}`}>
        <h3 className="text-[15px] font-semibold leading-snug" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
          {item.name}
        </h3>
        {item.description && cardStyle !== "COMPACT" && (
          <p className="line-clamp-2 text-[13px] leading-snug" style={{ color: "var(--menu-muted)" }}>
            {item.description}
          </p>
        )}
        <p className="mt-auto pt-1 text-[15px] font-bold tabular-nums" style={{ color: "var(--menu-primary)" }}>
          {formatPrice(item.price)} <span className="text-[11px] font-medium" style={{ color: "var(--menu-muted)" }}>RSD</span>
        </p>
      </div>
    </button>
  );
}

function ProductDetailModal({ item, imageShape, onClose }: { item: PublicMenuItem; imageShape: QrImageShape; onClose: () => void }) {
  const shapeClass = IMAGE_SHAPE_CLASS[imageShape];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="flex max-h-[88vh] w-full flex-col overflow-hidden sm:max-w-md sm:rounded-2xl"
        style={{ background: "var(--menu-surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`relative aspect-[4/3] w-full shrink-0 ${shapeClass === "rounded-sm" ? "" : "rounded-t-2xl sm:rounded-t-2xl"} overflow-hidden`}>
          {item.imageUrl ? (
            <Image src={item.imageUrl} alt="" fill sizes="480px" className="object-cover" />
          ) : (
            <NoImageTile name={item.name} shapeClass="" />
          )}
          <button
            onClick={onClose}
            aria-label="Zatvori"
            className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <h2 className="text-xl font-bold leading-snug" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
            {item.name}
          </h2>
          {!item.isAvailable && (
            <span className="mt-2 inline-block rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white">Trenutno nije dostupno</span>
          )}
          {item.description && (
            <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--menu-muted)" }}>
              {item.description}
            </p>
          )}
          <p className="mt-4 text-2xl font-bold tabular-nums" style={{ color: "var(--menu-primary)" }}>
            {formatPrice(item.price)} <span className="text-sm font-medium" style={{ color: "var(--menu-muted)" }}>RSD</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function PublicMenuView({ menu }: { menu: PublicMenuPayload }) {
  const { restaurant, theme, table, categories } = menu;
  const tokens = useMemo(() => resolveQrMenuTheme(theme), [theme]);
  const fonts = TYPOGRAPHY_FONT_VARS[theme.typographyPreset];

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(categories[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [openItem, setOpenItem] = useState<PublicMenuItem | null>(null);

  const searchTrimmed = search.trim().toLowerCase();
  const filteredCategories = useMemo(() => {
    if (!searchTrimmed) return categories;
    return categories
      .map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(searchTrimmed) || i.description?.toLowerCase().includes(searchTrimmed)) }))
      .filter((c) => c.items.length > 0);
  }, [categories, searchTrimmed]);

  const gridColsClass = theme.cardStyle === "COMPACT" ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3";

  return (
    <div
      className={`${FONT_VARIABLES} min-h-screen`}
      style={
        {
          ...tokens,
          "--menu-font-heading": fonts.heading,
          "--menu-font-body": fonts.body,
          background: "var(--menu-background)",
          color: "var(--menu-text)",
          fontFamily: "var(--menu-font-body)",
        } as React.CSSProperties
      }
    >
      {/* ── Hero — establishes restaurant identity immediately, but stays compact on mobile (guests came to browse food, spec section 12) ── */}
      <header className="relative">
        {restaurant.coverImageUrl && (
          <div className="relative h-32 w-full overflow-hidden sm:h-44">
            <Image src={restaurant.coverImageUrl} alt="" fill sizes="100vw" className="object-cover" priority />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          </div>
        )}
        <div className={`px-4 pb-4 pt-4 sm:px-6 ${restaurant.coverImageUrl ? "-mt-8" : ""}`}>
          <div className="flex items-end gap-3">
            {restaurant.logoUrl ? (
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full ring-4" style={{ background: "var(--menu-surface)", ["--tw-ring-color" as string]: "var(--menu-background)" }}>
                <Image src={restaurant.logoUrl} alt={restaurant.name} fill sizes="64px" className="object-cover" />
              </div>
            ) : (
              <div
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-xl font-bold ring-4"
                style={{ background: "var(--menu-primary)", color: "var(--menu-on-primary)", ["--tw-ring-color" as string]: "var(--menu-background)" }}
              >
                {restaurant.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 pb-0.5">
              <h1 className="truncate text-xl font-bold leading-tight sm:text-2xl" style={{ fontFamily: "var(--menu-font-heading)" }}>
                {restaurant.name}
              </h1>
              {restaurant.tagline && (
                <p className="truncate text-[13px]" style={{ color: "var(--menu-muted)" }}>
                  {restaurant.tagline}
                </p>
              )}
            </div>
          </div>
          {table && (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold" style={{ background: "var(--menu-surface)", border: "1px solid var(--menu-border)", color: "var(--menu-primary)" }}>
              Sto {table.label}
            </div>
          )}
        </div>
      </header>

      {/* ── Search ── */}
      <div className="px-4 sm:px-6">
        <div className="relative">
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--menu-muted)" }}>
            <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13 13L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pretraga menija…"
            aria-label="Pretraga menija"
            className="h-12 w-full rounded-full border pl-10 pr-4 text-[15px] outline-none"
            style={{ background: "var(--menu-surface)", borderColor: "var(--menu-border)", color: "var(--menu-text)" }}
          />
        </div>
      </div>

      {/* ── Sticky category navigation — immediate switching, no dropdown (spec section 13) ── */}
      {!searchTrimmed && categories.length > 1 && (
        <nav className="sticky top-0 z-30 mt-4 flex gap-2 overflow-x-auto px-4 py-2.5 backdrop-blur sm:px-6" style={{ background: "color-mix(in srgb, var(--menu-background) 88%, transparent)", borderBottom: "1px solid var(--menu-border)" }}>
          {categories.map((c) => {
            const active = c.id === activeCategoryId;
            return (
              <a
                key={c.id}
                href={`#cat-${c.id}`}
                onClick={() => setActiveCategoryId(c.id)}
                className="min-h-11 shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold transition-colors"
                style={active ? { background: "var(--menu-primary)", color: "var(--menu-on-primary)" } : { background: "var(--menu-surface)", color: "var(--menu-muted)", border: "1px solid var(--menu-border)" }}
              >
                {c.name}
              </a>
            );
          })}
        </nav>
      )}

      {/* ── Categories + items ── */}
      <main className="px-4 pb-16 pt-4 sm:px-6">
        {filteredCategories.length === 0 && (
          <p className="py-12 text-center text-sm" style={{ color: "var(--menu-muted)" }}>
            Nema rezultata za "{search}".
          </p>
        )}
        {filteredCategories.map((category) => (
          <section key={category.id} id={`cat-${category.id}`} className="mb-8 scroll-mt-20">
            <h2 className="mb-3 text-lg font-bold" style={{ fontFamily: "var(--menu-font-heading)" }}>
              {category.name}
            </h2>
            <div className={`grid gap-3 ${gridColsClass}`}>
              {category.items.map((item) => (
                <ProductCard key={item.id} item={item} cardStyle={theme.cardStyle} imageShape={theme.imageShape} onOpen={() => setOpenItem(item)} />
              ))}
            </div>
          </section>
        ))}
      </main>

      <footer className="px-4 pb-8 pt-2 text-center text-[11px] sm:px-6" style={{ color: "var(--menu-muted)" }}>
        {restaurant.name}
      </footer>

      {openItem && <ProductDetailModal item={openItem} imageShape={theme.imageShape} onClose={() => setOpenItem(null)} />}
    </div>
  );
}
