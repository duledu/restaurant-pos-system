"use client";

import { useState } from "react";
import Image from "next/image";
import { TableCoreLogo, SIZE_MAP } from "../ui/TableCoreLogo";
import { APP_NAME } from "./constants";

export { APP_NAME };

type Variant = "full" | "mark" | "wordmark";
type Theme = "dark" | "light";
type Size = "sm" | "md" | "lg" | "xl";

interface AppLogoProps {
  variant?: Variant;
  theme?: Theme;
  size?: Size;
  className?: string;
}

// ── Stvarni brend asset-i (postavljeni od strane korisnika — ne diraj/ne
// dupliraj fajlove, samo referenciraj po imenu). Razmak u imenu prvog
// fajla mora biti URL-enkodiran.
const LIGHT_SRC = "/branding/tablecore.net.logo-removebg-preview%20(1).png";
const LIGHT_NATURAL = { width: 500, height: 500 };
// Isečak SAMO mark-a (oval+stub+"C") unutar kompletnog lockup-a — koordinate
// dobijene skeniranjem piksela fajla (vidi razgovor), sa malom bezbednosnom
// marginom oko stvarnog sadržaja.
const LIGHT_MARK_CROP = { x0: 150, y0: 115, x1: 350, y1: 285 };

const DARK_SRC = "/branding/tablecore.net.logo-white.png";
const DARK_NATURAL = { width: 338, height: 234 };
// NAPOMENA: ovaj fajl je isporučen sa nepotpunim/isečenim wordmark-om
// (tekst se preseca na sredini slova, nema podnaslova — verovatno greška
// pri auto-trim izvozu, ne namerni dizajn). Mark deo (ikonica) je i dalje
// potpuno čitav i čisto odvojen od pokvarenog teksta praznim redom piksela
// (y≈150–160), pa koristimo SAMO taj isečak — vidi "full" granu ispod, koja
// pored njega renderuje pravi HTML tekst "TableCore" umesto pokvarenog
// dela slike. Ako se fajl kasnije zameni ispravnom (kompletnom) belom
// verzijom, ovaj poseban tretman postaje nepotreban i može se ukloniti.
const DARK_MARK_CROP = { x0: 68, y0: 0, x1: 262, y1: 155 };

interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Prikazuje SAMO pravougaonik `crop` iz `src` (u prirodnim pikselima slike),
 * skaliran na `heightPx`, bez izobličenja — koristi next/image sa punom
 * (neizsečenom) veličinom pozicioniranom apsolutno unutar `overflow:hidden`
 * kontejnera tačne (isečene) razmere. Kontejner nasleđuje aspect ratio
 * isečka automatski (containerWidth = cropWidth * scale), pa nema rizika od
 * razmimoilaženja razmere.
 */
function CroppedMark({
  src,
  natural,
  crop,
  heightPx,
  className = "",
  onError,
}: {
  src: string;
  natural: { width: number; height: number };
  crop: Crop;
  heightPx: number;
  className?: string;
  onError: () => void;
}) {
  const cropW = crop.x1 - crop.x0;
  const cropH = crop.y1 - crop.y0;
  const scale = heightPx / cropH;
  const containerWidth = Math.round(cropW * scale);
  const renderedWidth = Math.round(natural.width * scale);
  const renderedHeight = Math.round(natural.height * scale);

  return (
    <span
      role="img"
      aria-label={APP_NAME}
      className={`relative inline-block shrink-0 overflow-hidden ${className}`}
      style={{ width: containerWidth, height: heightPx }}
    >
      <Image
        src={src}
        alt={APP_NAME}
        width={renderedWidth}
        height={renderedHeight}
        style={{
          position: "absolute",
          left: -Math.round(crop.x0 * scale),
          top: -Math.round(crop.y0 * scale),
          maxWidth: "none",
          width: renderedWidth,
          height: renderedHeight,
        }}
        onError={onError}
      />
    </span>
  );
}

/**
 * Centralni prikaz TableCore branding-a (naš POS PROIZVOD) — NIJE logo
 * pojedinačnog restorana koji koristi TableCore (to ostaje odvojen,
 * kasnije-konfigurabilan koncept po restoranu, npr. na računu). Zameni
 * `public/branding/*` fajlove da promeniš logo SVUDA u aplikaciji, bez
 * diranja koda — vidi README "Global App Logo".
 *
 * Bira ispravnu varijantu (svetla/tamna) automatski na osnovu `theme`
 * prop-a koji poziva svaki ekran prema svojoj pozadini — pozivalac nikad
 * ne bira fajl direktno.
 *
 * Ako izabrani asset (privremeno) ne postoji ili ne uspe da se učita, tiho
 * prelazi na ugrađeni TableCoreLogo SVG (koji ne zavisi od spoljnog
 * fajla) — branding asset koji nedostaje NIKAD ne sme da obori ekran.
 */
export function AppLogo({ variant = "full", theme = "light", size = "md", className = "" }: AppLogoProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const handleError = () => setImageFailed(true);

  if (imageFailed) {
    return <TableCoreLogo variant={variant} theme={theme} size={size} className={className} />;
  }

  const markPx = typeof SIZE_MAP[size].mark === "number" ? (SIZE_MAP[size].mark as number) : 56;

  if (variant === "wordmark") {
    // Nijedan od dva isporučena fajla nije zaseban "samo tekst" isečak —
    // ovo se trenutno nigde u aplikaciji ne koristi, pa ostaje na SVG-u da
    // ne kompliкujemo cropping logiku za nekorišćen slučaj.
    return <TableCoreLogo variant="wordmark" theme={theme} size={size} className={className} />;
  }

  if (variant === "mark") {
    return theme === "dark" ? (
      <CroppedMark src={DARK_SRC} natural={DARK_NATURAL} crop={DARK_MARK_CROP} heightPx={markPx} className={className} onError={handleError} />
    ) : (
      <CroppedMark src={LIGHT_SRC} natural={LIGHT_NATURAL} crop={LIGHT_MARK_CROP} heightPx={markPx} className={className} onError={handleError} />
    );
  }

  // variant === "full"
  if (theme === "light") {
    // Isporučeni fajl je VERTIKALNI lockup (ikonica iznad teksta) uklopljen
    // u kvadratno 500x500 platno — renderovanje cele slike u širokom/niskom
    // kontejneru (npr. h-6 w-28 mobilno zaglavlje) skalira po VISINI celog
    // kvadrata, pa ostaje sitna ikonica uz veliki prazan prostor pored nje
    // (potvrđeno vizuelnim pregledom fajla). Isti tretman kao tamna tema
    // ispod: rekonstruišemo širok lockup od već isečene ikonice
    // (LIGHT_MARK_CROP) + pravog HTML teksta, istim rasporedom/veličinama
    // kao TableCoreLogo.tsx, tako da lockup ima ispravan (širok) aspect
    // ratio na svakoj veličini kontejnera.
    const { text, sub } = SIZE_MAP[size];
    return (
      <span className={`inline-flex max-w-full items-center gap-2 shrink-0 ${className}`} aria-label={`${APP_NAME} Restaurant Control System`}>
        <CroppedMark src={LIGHT_SRC} natural={LIGHT_NATURAL} crop={LIGHT_MARK_CROP} heightPx={markPx} onError={handleError} />
        <span className="flex min-w-0 flex-col justify-center leading-none">
          <span className="whitespace-nowrap" style={{ fontSize: text, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
            <span style={{ color: "#0A1931" }}>Table</span>
            <span style={{ color: "#4A7FA7" }}>Core</span>
          </span>
          {size !== "sm" && (
            <span
              className="whitespace-nowrap"
              style={{ fontSize: sub, color: "rgba(74,127,167,0.7)", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 3, fontWeight: 500 }}
            >
              Restaurant Control System
            </span>
          )}
        </span>
      </span>
    );
  }

  // theme === "dark": wordmark deo isporučenog fajla je isečen/pokvaren
  // (vidi napomenu kod DARK_MARK_CROP) — rekonstruišemo lockup od pravog
  // isečenog mark-a + HTML teksta, ISTIM rasporedom/veličinama kao
  // TableCoreLogo.tsx (SIZE_MAP) da ekrani izgledaju identično dok se
  // eventualno ne zameni ispravan beli fajl.
  const { text, sub } = SIZE_MAP[size];
  return (
    <span className={`inline-flex max-w-full items-center gap-2 shrink-0 ${className}`} aria-label={`${APP_NAME} Restaurant Control System`}>
      <CroppedMark src={DARK_SRC} natural={DARK_NATURAL} crop={DARK_MARK_CROP} heightPx={markPx} onError={handleError} />
      <span className="flex min-w-0 flex-col justify-center leading-none">
        <span className="whitespace-nowrap" style={{ fontSize: text, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
          <span style={{ color: "#FFFFFF" }}>Table</span>
          <span style={{ color: "#B3CFE5" }}>Core</span>
        </span>
        {size !== "sm" && (
          <span
            className="whitespace-nowrap"
            style={{ fontSize: sub, color: "rgba(179,207,229,0.65)", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 3, fontWeight: 500 }}
          >
            Restaurant Control System
          </span>
        )}
      </span>
    </span>
  );
}
