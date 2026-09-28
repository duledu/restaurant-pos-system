"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Playfair_Display, Inter, Outfit, Work_Sans, Cormorant_Garamond, Libre_Baskerville, Fredoka, Nunito } from "next/font/google";
import { resolveQrMenuTheme, type QrThemePreset, type QrTypographyPreset, type QrCardStyle, type QrImageShape } from "@rcs/shared";

// ── BRANDED QR MENU — EDITORIAL GOLDEN LAYOUT ────────────────────────────
//
// Deliberately its OWN visual language, not a reskin of TableCore's
// internal Admin/Waiter UI — this file never imports TableCore's internal
// component library. Theming stays 100% data-driven (CSS custom properties
// resolved from QrMenuSettings via resolveQrMenuTheme) so the SAME
// components/markup render every restaurant differently.
//
// REDESIGN NOTE (golden mobile experience, replaces the previous product-
// card grid): a menu item is a TYPOGRAPHIC ROW, never a bordered/shadowed
// card — see MenuRow below. Photography creates RHYTHM rather than filling
// a thumbnail slot in every row: the first item in a category that has a
// photo becomes that category's full-width SpotlightBlock; any further
// photographed items become smaller horizontal MomentBlocks; everything
// else (including every item at all, for a restaurant with zero photos)
// renders as a plain MenuRow. See classifyItemPhotos.
//
// LAYOUT vs THEME (spec: "layoutPreset is not themePreset"): this file IS
// today's only layout. `theme.cardStyle` (a pre-existing, still-stored
// QrMenuSettings field from the card-grid era) is intentionally NOT read
// here — it has no meaning in a card-less composition — but it is left
// completely untouched in the schema/Admin UI so a FUTURE non-editorial
// layout preset can still read it. `theme.imageShape` DOES still apply, to
// the corner treatment of Spotlight/Moment photography. No backend/schema
// change was made for this redesign.
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

const IMAGE_RADIUS_CLASS: Record<QrImageShape, string> = {
  ROUNDED: "rounded-2xl",
  SOFT: "rounded-md",
  SQUARE: "rounded-none",
};

type PhotoTreatment = "spotlight" | "moment" | "none";

/** Pure — first photographed item in a category leads as the full-width Spotlight; any further photographed items become smaller Moment pairings; everything else is a plain typographic row. Never reorders items. */
function classifyItemPhotos(items: PublicMenuItem[]): Map<string, PhotoTreatment> {
  const result = new Map<string, PhotoTreatment>();
  let seenPhoto = false;
  for (const item of items) {
    if (!item.imageUrl) {
      result.set(item.id, "none");
    } else if (!seenPhoto) {
      result.set(item.id, "spotlight");
      seenPhoto = true;
    } else {
      result.set(item.id, "moment");
    }
  }
  return result;
}

function Price({ item }: { item: PublicMenuItem }) {
  return (
    <span className="shrink-0 whitespace-nowrap pl-3 text-[15px] tabular-nums" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
      {formatPrice(item.price)}
      <span className="ml-0.5 text-[10px] font-normal" style={{ color: "var(--menu-muted)" }}>RSD</span>
    </span>
  );
}

function UnavailableLabel() {
  return (
    <span className="text-[11px] font-medium italic" style={{ color: "var(--menu-muted)" }}>
      Trenutno nije dostupno
    </span>
  );
}

/** The default composition — a name/price baseline with an optional description beneath, separated from the next row by a hairline. This IS the product: typography, not a container. */
function MenuRow({ item, onOpen, showRule }: { item: PublicMenuItem; onOpen: () => void; showRule: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`block w-full py-3.5 text-left transition-opacity motion-reduce:transition-none ${!item.isAvailable ? "opacity-60" : "active:opacity-70"} ${showRule ? "border-b" : ""}`}
      style={{ borderColor: "var(--menu-border)" }}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[16px] font-medium leading-snug" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
          {item.name}
        </span>
        <Price item={item} />
      </span>
      {item.description && (
        <span className="mt-1 block max-w-[62ch] text-[13.5px] leading-snug" style={{ color: "var(--menu-muted)" }}>
          {item.description}
        </span>
      )}
      {!item.isAvailable && <span className="mt-1 block"><UnavailableLabel /></span>}
    </button>
  );
}

/** The category's one big visual moment — full-bleed-feeling photography with name/price overlaid, description below in normal flow (never overlaid on the photo — legibility over drama). */
function SpotlightBlock({ item, imageShape, onOpen }: { item: PublicMenuItem; imageShape: QrImageShape; onOpen: () => void }) {
  const radius = IMAGE_RADIUS_CLASS[imageShape];
  return (
    <button type="button" onClick={onOpen} className="mb-5 block w-full text-left">
      <span className={`relative block aspect-[16/10] w-full overflow-hidden ${radius}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary admin-pasted external URL; server-side next/image fetching would be an SSRF surface on this unauthenticated route */}
        <img src={item.imageUrl!} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/5 to-transparent" />
        <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-4">
          <span className="text-[19px] font-semibold leading-tight text-white" style={{ fontFamily: "var(--menu-font-heading)" }}>
            {item.name}
          </span>
          <span className="shrink-0 whitespace-nowrap pl-3 text-[16px] tabular-nums text-white" style={{ fontFamily: "var(--menu-font-heading)" }}>
            {formatPrice(item.price)} <span className="text-[10px] font-normal opacity-80">RSD</span>
          </span>
        </span>
        {!item.isAvailable && (
          <span className="absolute right-3 top-3 rounded-sm bg-black/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">Nedostupno</span>
        )}
      </span>
      {item.description && (
        <span className="mt-2 block max-w-[62ch] text-[13.5px] leading-snug" style={{ color: "var(--menu-muted)" }}>
          {item.description}
        </span>
      )}
    </button>
  );
}

/** A secondary visual moment — smaller, paired with its text rather than dominating it. Still no border/shadow/card container. */
function MomentBlock({ item, imageShape, onOpen, showRule }: { item: PublicMenuItem; imageShape: QrImageShape; onOpen: () => void; showRule: boolean }) {
  const radius = IMAGE_RADIUS_CLASS[imageShape];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full gap-3.5 py-3.5 text-left transition-opacity motion-reduce:transition-none ${!item.isAvailable ? "opacity-60" : "active:opacity-70"} ${showRule ? "border-b" : ""}`}
      style={{ borderColor: "var(--menu-border)" }}
    >
      <span className={`relative h-20 w-20 shrink-0 overflow-hidden ${radius}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- see SpotlightBlock's identical note */}
        <img src={item.imageUrl!} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[16px] font-medium leading-snug" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
            {item.name}
          </span>
          <Price item={item} />
        </span>
        {item.description && (
          <span className="mt-1 block line-clamp-2 text-[13.5px] leading-snug" style={{ color: "var(--menu-muted)" }}>
            {item.description}
          </span>
        )}
        {!item.isAvailable && <span className="mt-1 block"><UnavailableLabel /></span>}
      </span>
    </button>
  );
}

function ProductDetail({ item, imageShape, onClose }: { item: PublicMenuItem; imageShape: QrImageShape; onClose: () => void }) {
  const radius = IMAGE_RADIUS_CLASS[imageShape];
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose} onKeyDown={onKeyDown} role="dialog" aria-modal="true" tabIndex={-1}>
      <div
        className={`flex max-h-[85vh] w-full flex-col overflow-hidden sm:max-w-md ${item.imageUrl ? "" : "pt-1"} rounded-t-3xl sm:rounded-3xl`}
        style={{ background: "var(--menu-surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mx-auto mb-1 mt-2.5 h-1 w-10 shrink-0 rounded-full sm:hidden" style={{ background: "var(--menu-border)" }} aria-hidden="true" />
        {item.imageUrl && (
          <div className={`relative aspect-[4/3] w-full shrink-0 overflow-hidden ${radius === "rounded-none" ? "" : "rounded-t-2xl"}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- see SpotlightBlock's identical note */}
            <img src={item.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          </div>
        )}
        <button
          onClick={onClose}
          aria-label="Zatvori"
          autoFocus
          className={`absolute right-3 flex h-11 w-11 items-center justify-center rounded-full backdrop-blur ${item.imageUrl ? "top-3 bg-black/40 text-white" : "top-2"}`}
          style={item.imageUrl ? undefined : { color: "var(--menu-muted)" }}
        >
          ✕
        </button>
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-5">
          <h2 className="text-[22px] font-semibold leading-snug" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
            {item.name}
          </h2>
          {!item.isAvailable && <span className="mt-1.5 block"><UnavailableLabel /></span>}
          {item.description && (
            <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--menu-muted)" }}>
              {item.description}
            </p>
          )}
          <p className="mt-5 text-[20px] tabular-nums" style={{ color: "var(--menu-text)", fontFamily: "var(--menu-font-heading)" }}>
            {formatPrice(item.price)} <span className="text-[12px] font-normal" style={{ color: "var(--menu-muted)" }}>RSD</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" width="18" height="18">
      <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13 13L17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function PublicMenuView({ menu }: { menu: PublicMenuPayload }) {
  const { restaurant, theme, table, categories } = menu;
  const tokens = useMemo(() => resolveQrMenuTheme(theme), [theme]);
  const fonts = TYPOGRAPHY_FONT_VARS[theme.typographyPreset];

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(categories[0]?.id ?? null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openItem, setOpenItem] = useState<PublicMenuItem | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const searchTrimmed = search.trim().toLowerCase();
  const filteredCategories = useMemo(() => {
    if (!searchTrimmed) return categories;
    return categories
      .map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(searchTrimmed) || i.description?.toLowerCase().includes(searchTrimmed)) }))
      .filter((c) => c.items.length > 0);
  }, [categories, searchTrimmed]);

  return (
    <div
      className={`${FONT_VARIABLES} min-h-screen overflow-x-hidden`}
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
      {/* ── Identity — compact, typography-forward; a cover photo (when set) is a short atmospheric strip with identity overlaid, never a dominant hero (guests came to browse food) ── */}
      <header className="relative">
        {restaurant.coverImageUrl ? (
          <div className="relative flex h-40 w-full flex-col justify-end overflow-hidden px-5 pb-4 sm:h-48 sm:px-8">
            {/* eslint-disable-next-line @next/next/no-img-element -- see SpotlightBlock's identical note; eager (above the fold), never lazy */}
            <img src={restaurant.coverImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-black/10" />
            <div className="relative">
              <h1 className="text-[26px] font-semibold leading-none text-white sm:text-[30px]" style={{ fontFamily: "var(--menu-font-heading)" }}>
                {restaurant.name}
              </h1>
              {restaurant.tagline && <p className="mt-1.5 text-[13px] text-white/85">{restaurant.tagline}</p>}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-5 pb-3 pt-6 sm:px-8">
            {restaurant.logoUrl ? (
              <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full">
                {/* eslint-disable-next-line @next/next/no-img-element -- see SpotlightBlock's identical note */}
                <img src={restaurant.logoUrl} alt={restaurant.name} className="absolute inset-0 h-full w-full object-cover" />
              </span>
            ) : (
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-semibold" style={{ background: "var(--menu-primary)", color: "var(--menu-on-primary)" }}>
                {restaurant.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-[22px] font-semibold leading-tight" style={{ fontFamily: "var(--menu-font-heading)" }}>
                {restaurant.name}
              </h1>
              {restaurant.tagline && <p className="truncate text-[12.5px]" style={{ color: "var(--menu-muted)" }}>{restaurant.tagline}</p>}
            </div>
          </div>
        )}
        {table && (
          <div className="px-5 pt-3 sm:px-8">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--menu-primary)" }}>
              Sto {table.label}
            </span>
          </div>
        )}
      </header>

      {/* ── Sticky utility bar — slim underline category tabs + a search affordance that expands only when needed, never dominating the identity area ── */}
      <div className="sticky top-0 z-30 backdrop-blur" style={{ background: "color-mix(in srgb, var(--menu-background) 92%, transparent)", borderBottom: "1px solid var(--menu-border)" }}>
        <div className="mx-auto flex max-w-2xl items-center gap-1 px-2 sm:px-6">
          {!searchOpen && categories.length > 1 && (
            // Right-edge fade (mask-image, not an opacity trick) signals
            // "more categories to scroll" instead of an abrupt mid-word
            // clip against the search icon — pure CSS, no extra markup.
            <nav
              className="flex min-w-0 flex-1 gap-5 overflow-x-auto px-3 py-3 [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]"
              style={{ scrollbarWidth: "none" }}
            >
              {categories.map((c) => {
                const active = c.id === activeCategoryId && !searchTrimmed;
                return (
                  <a
                    key={c.id}
                    href={`#cat-${c.id}`}
                    onClick={() => setActiveCategoryId(c.id)}
                    className="shrink-0 whitespace-nowrap border-b-2 pb-1 pt-0.5 text-[13px] font-semibold uppercase tracking-wide transition-colors motion-reduce:transition-none"
                    style={active ? { borderColor: "var(--menu-primary)", color: "var(--menu-text)" } : { borderColor: "transparent", color: "var(--menu-muted)" }}
                  >
                    {c.name}
                  </a>
                );
              })}
            </nav>
          )}
          {searchOpen ? (
            <div className="flex flex-1 items-center gap-2 py-2.5">
              <span style={{ color: "var(--menu-muted)" }}>
                <SearchIcon />
              </span>
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pretraga menija…"
                aria-label="Pretraga menija"
                className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
                style={{ color: "var(--menu-text)" }}
              />
              <button
                onClick={() => { setSearchOpen(false); setSearch(""); }}
                aria-label="Zatvori pretragu"
                className="flex h-11 w-11 shrink-0 items-center justify-center"
                style={{ color: "var(--menu-muted)" }}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSearchOpen(true)}
              aria-label="Pretraga menija"
              className="flex h-11 w-11 shrink-0 items-center justify-center"
              style={{ color: "var(--menu-muted)" }}
            >
              <SearchIcon />
            </button>
          )}
        </div>
      </div>

      {/* ── The menu itself — an editorial canvas, not a product grid ── */}
      <main className="mx-auto max-w-2xl px-5 pb-16 pt-6 sm:px-8">
        {filteredCategories.length === 0 && (
          <p className="py-16 text-center text-sm" style={{ color: "var(--menu-muted)" }}>
            Nema rezultata za &quot;{search}&quot;.
          </p>
        )}
        {filteredCategories.map((category, categoryIndex) => {
          const treatments = classifyItemPhotos(category.items);
          return (
            <section key={category.id} id={`cat-${category.id}`} className={`scroll-mt-16 ${categoryIndex > 0 ? "mt-10" : ""}`}>
              <div className="mb-4 flex items-center gap-3">
                <h2 className="text-[24px] font-semibold leading-none" style={{ fontFamily: "var(--menu-font-heading)" }}>
                  {category.name}
                </h2>
                <span className="h-px flex-1" style={{ background: "var(--menu-border)" }} aria-hidden="true" />
              </div>
              <div>
                {category.items.map((item, itemIndex) => {
                  const treatment = treatments.get(item.id);
                  const isLast = itemIndex === category.items.length - 1;
                  if (treatment === "spotlight") {
                    return <SpotlightBlock key={item.id} item={item} imageShape={theme.imageShape} onOpen={() => setOpenItem(item)} />;
                  }
                  if (treatment === "moment") {
                    return <MomentBlock key={item.id} item={item} imageShape={theme.imageShape} onOpen={() => setOpenItem(item)} showRule={!isLast} />;
                  }
                  return <MenuRow key={item.id} item={item} onOpen={() => setOpenItem(item)} showRule={!isLast} />;
                })}
              </div>
            </section>
          );
        })}
      </main>

      <footer className="px-5 pb-10 pt-4 text-center text-[11px] sm:px-8" style={{ color: "var(--menu-muted)" }}>
        {restaurant.name}
      </footer>

      {openItem && <ProductDetail item={openItem} imageShape={theme.imageShape} onClose={() => setOpenItem(null)} />}
    </div>
  );
}
