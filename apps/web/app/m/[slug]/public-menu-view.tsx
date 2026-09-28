"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Playfair_Display, Inter, Outfit, Cormorant_Garamond, Fredoka } from "next/font/google";
import { resolveQrMenuTheme, type QrTypographyPreset } from "@rcs/shared";
import type { PublicMenuItem, PublicMenuPayload } from "@rcs/domain/qrmenu/qr-menu-service";
import { editorialItemId, filterPublicMenu, publicImageSource, type MenuMode } from "../../../lib/public-menu";
import styles from "./public-menu.module.css";

export type { PublicMenuPayload } from "@rcs/domain/qrmenu/qr-menu-service";

// One rendering engine for guests and the narrow Admin preview. The stored
// typography and image-shape presets remain authoritative; cardStyle is legacy.
const playfair = Playfair_Display({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-menu-elegant", display: "swap", preload: false });
const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-menu-body", display: "swap" });
const outfit = Outfit({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-menu-modern", display: "swap", preload: false });
const cormorant = Cormorant_Garamond({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-menu-classic", display: "swap", preload: false });
const fredoka = Fredoka({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-menu-casual", display: "swap", preload: false });
const FONT_VARIABLES = [playfair, inter, outfit, cormorant, fredoka].map(font => font.variable).join(" ");
const DISPLAY: Record<QrTypographyPreset, string> = {
  ELEGANT: "var(--font-menu-elegant), Georgia, serif",
  MODERN: "var(--font-menu-modern), sans-serif",
  CLASSIC: "var(--font-menu-classic), Georgia, serif",
  CASUAL: "var(--font-menu-casual), sans-serif",
};
const PRICE_FORMAT = new Intl.NumberFormat("sr-RS", { maximumFractionDigits: 2 });
const MODES = [{ id: "KITCHEN", label: "Kuhinja", icon: "kitchen" }, { id: "BAR", label: "Šank", icon: "bar" }] as const;

function Icon({ name }: { name: "search" | "close" | "kitchen" | "bar" | "arrow" }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {name === "search" && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>}
    {name === "close" && <path d="m6 6 12 12M6 18 18 6" />}
    {name === "kitchen" && <><path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M19 21V3c-4 3-5 7-5 11h5" /></>}
    {name === "bar" && <><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3ZM12 15v6M8 21h8M6 7h12" /></>}
    {name === "arrow" && <path d="M5 12h14m-5-5 5 5-5 5" />}
  </svg>;
}

function Photo({ src, className, eager = false, onError }: { src: string | null; className: string; eager?: boolean; onError?: () => void }) {
  const [failedSource, setFailedSource] = useState<string>();
  const source = publicImageSource(src);
  if (!source || failedSource === source) return null;
  // Deliberately browser-fetched. No remote Next Image optimizer / SSRF surface.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={source} alt="" width={800} height={600} loading={eager ? "eager" : "lazy"} decoding="async" {...{ fetchpriority: eager ? "high" : "auto" }} className={className} onError={() => { setFailedSource(source); onError?.(); }} />;
}

function Price({ item }: { item: PublicMenuItem }) {
  const amount = Number(item.price);
  return <span className={styles.price}>{Number.isFinite(amount) ? PRICE_FORMAT.format(amount) : item.price}<span>RSD</span></span>;
}

function Availability() {
  return <span className={styles.availability}>Trenutno nije dostupno</span>;
}

function MenuRow({ item, editorial, onOpen }: { item: PublicMenuItem; editorial: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const featured = editorial && publicImageSource(item.imageUrl) && failed !== item.imageUrl;
  return <button type="button" className={`${styles.row} ${featured ? styles.editorial : ""}`} data-available={item.isAvailable} onClick={onOpen} aria-haspopup="dialog">
    <Photo key={item.imageUrl} src={item.imageUrl} className={styles.thumbnail} onError={() => setFailed(item.imageUrl)} />
    <span className={styles.dish}>
      <span className={styles.dishName}>{item.name}</span>
      {item.description && <span className={styles.description}>{item.description}</span>}
      {!item.isAvailable && <Availability />}
      {featured && <span className={styles.detailHint}>Detalji <Icon name="arrow" /></span>}
    </span>
    <Price item={item} />
  </button>;
}

function ProductDetail({ item, onClose }: { item: PublicMenuItem; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; opener?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialogRef} className={styles.detail} aria-labelledby={headingId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <article className={styles.detailInner}>
      <button type="button" className={styles.closeDetail} aria-label="Zatvori detalje" onClick={onClose}><Icon name="close" /></button>
      <Photo src={item.imageUrl} className={styles.detailPhoto} eager />
      <div className={styles.detailBody}>
        <p className={styles.eyebrow}>Iz našeg menija</p>
        <h2 id={headingId}>{item.name}</h2>
        {item.description && <p className={styles.detailDescription}>{item.description}</p>}
        {!item.isAvailable && <Availability />}
        <Price item={item} />
      </div>
    </article>
  </dialog>;
}

export function PublicMenuView({ menu }: { menu: PublicMenuPayload }) {
  const { restaurant, theme, table, categories } = menu;
  const instanceId = useId().replace(/:/g, "");
  const tokens = useMemo(() => resolveQrMenuTheme(theme), [theme]);
  const [mode, setMode] = useState<MenuMode>(() => filterPublicMenu(categories, "KITCHEN").length ? "KITCHEN" : "BAR");
  const [activeCategory, setActiveCategory] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openItem, setOpenItem] = useState<PublicMenuItem | null>(null);
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const categoryNavRef = useRef<HTMLElement>(null);
  const categoryJumpRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(() => filterPublicMenu(categories, mode, search), [categories, mode, search]);
  const selectedId = filtered.some(category => category.id === activeCategory) ? activeCategory : filtered[0]?.id;
  const cover = publicImageSource(restaurant.coverImageUrl) && failedCover !== restaurant.coverImageUrl;

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // Track reading position in either the public document or Admin's scroll frame.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent = root.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    const scrollRoot: HTMLElement | Window = parent ?? window;
    let frame = 0;
    const update = () => {
      // At the document end an anchor cannot always reach the sticky edge.
      // Honor that explicit category selection for the resulting scroll event.
      if (categoryJumpRef.current) {
        setActiveCategory(categoryJumpRef.current);
        categoryJumpRef.current = null;
        return;
      }
      const edge = (navRef.current?.getBoundingClientRect().bottom ?? 0) + 24;
      const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-menu-category]"));
      const current = sections.filter(section => section.getBoundingClientRect().top <= edge).at(-1) ?? sections[0];
      if (current) setActiveCategory(current.dataset.menuCategory);
    };
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(() => {
      root.style.setProperty("--menu-nav-height", `${navRef.current?.offsetHeight ?? 116}px`);
      onScroll();
    });
    if (navRef.current) resize.observe(navRef.current);
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { scrollRoot.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); resize.disconnect(); };
  }, [filtered]);

  useEffect(() => {
    const nav = categoryNavRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !active) return;
    const bounds = nav.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < bounds.left || tab.right > bounds.right) nav.scrollLeft += tab.left - bounds.left - 16;
  }, [selectedId]);

  function closeSearch() {
    setSearchOpen(false);
    setSearch("");
    requestAnimationFrame(() => searchButtonRef.current?.focus());
  }

  return <div ref={rootRef} className={`${styles.menu} ${FONT_VARIABLES}`} data-theme={theme.themePreset} style={{ ...tokens, "--menu-font-heading": DISPLAY[theme.typographyPreset], "--menu-font-body": "var(--font-menu-body), Arial, sans-serif" } as CSSProperties}>
    <a className={styles.skipLink} href={`#${instanceId}-content`}>Pređi na meni</a>
    <header className={`${styles.hero} ${cover ? styles.photographic : styles.branded}`}>
      <Photo src={restaurant.coverImageUrl} className={styles.cover} eager onError={() => setFailedCover(restaurant.coverImageUrl)} />
      <div className={styles.heroContent}>
        <div className={styles.heroTop}>
          <span className={styles.eyebrow}>Dobro došli</span>
          {table && <span className={styles.table}>Sto {table.label}</span>}
        </div>
        <div className={styles.identity}>
          <Photo src={restaurant.logoUrl} className={styles.logo} eager />
          <div><h1>{restaurant.name}</h1>{restaurant.tagline && <p className={styles.tagline}>{restaurant.tagline}</p>}</div>
        </div>
        <div className={styles.heroFoot}><span>Naš meni</span><span aria-hidden="true">↓</span></div>
      </div>
    </header>

    <div ref={navRef} className={styles.navigation}>
      <div className={styles.navCanvas}>
        <div className={styles.modes} role="group" aria-label="Vrsta menija">
          {MODES.map(tab => <button key={tab.id} type="button" aria-pressed={mode === tab.id} aria-controls={`${instanceId}-content`} onClick={() => { setMode(tab.id); setActiveCategory(undefined); }}>
            <Icon name={tab.icon} /><span>{tab.label}</span><span className={styles.modeNumber}>{tab.id === "KITCHEN" ? "01" : "02"}</span>
          </button>)}
        </div>
        <div className={styles.categoryBar}>
          {searchOpen ? <div className={styles.search}>
            <Icon name="search" />
            <input ref={searchInputRef} type="search" aria-label={`Pretraži ${mode === "KITCHEN" ? "kuhinju" : "šank"}`} placeholder="Pronađite u meniju…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") closeSearch(); }} />
            <button type="button" className={styles.iconButton} aria-label="Zatvori pretragu" onClick={closeSearch}><Icon name="close" /></button>
          </div> : <>
            <nav ref={categoryNavRef} className={styles.categories} aria-label="Kategorije menija">
              {filtered.map(category => <a key={category.id} href={`#${instanceId}-${category.id}`} aria-current={selectedId === category.id ? "true" : undefined} onClick={() => { categoryJumpRef.current = category.id; setActiveCategory(category.id); }}>{category.name}</a>)}
            </nav>
            <button ref={searchButtonRef} type="button" className={styles.iconButton} aria-label="Pretraga menija" aria-expanded={false} onClick={() => setSearchOpen(true)}><Icon name="search" /></button>
          </>}
        </div>
      </div>
    </div>

    <main id={`${instanceId}-content`} className={styles.content} tabIndex={-1}>
      {search.trim() && <p role="status" className={styles.searchStatus}>Rezultati: {filtered.reduce((total, category) => total + category.items.length, 0)}</p>}
      {!filtered.length && <div className={styles.empty}><h2>{search.trim() ? "Nema rezultata" : "Meni uskoro"}</h2><p>{search.trim() ? `Pokušajte sa drugim nazivom ili otvorite ${mode === "KITCHEN" ? "Šank" : "Kuhinju"}.` : "Ponuda trenutno nije dostupna."}</p>{search.trim() && <button type="button" onClick={() => setSearch("")}>Obriši pretragu</button>}</div>}
      {filtered.map((category, index) => {
        const editorialId = search.trim() ? null : editorialItemId(category, index);
        return <section key={category.id} id={`${instanceId}-${category.id}`} data-menu-category={category.id} className={`${styles.section} ${editorialId ? styles.withEditorial : ""}`}>
          <div className={styles.sectionHeading}>
            <span className={styles.sectionNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <h2>{category.name}</h2>
            <span className={styles.categoryCount}>{category.items.length} <span>u ponudi</span></span>
          </div>
          <div className={styles.dishes}>
            {category.items.map(item => <MenuRow key={item.id} item={item} editorial={item.id === editorialId} onOpen={() => setOpenItem(item)} />)}
          </div>
        </section>;
      })}
    </main>
    <footer className={styles.footer}><span className={styles.footerMark} aria-hidden="true" /><p>{restaurant.name}</p><span>Hvala što ste naši gosti.</span></footer>
    {openItem && <ProductDetail item={openItem} onClose={() => setOpenItem(null)} />}
  </div>;
}
