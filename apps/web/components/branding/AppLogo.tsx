"use client";

import { useState } from "react";
import Image from "next/image";
import { TableCoreLogo } from "../ui/TableCoreLogo";
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

// Fiksne dimenzije po (variant, size) — next/image sa `fill` zahteva
// roditelja sa definisanim dimenzijama (sprečava layout shift dok se
// app-logo.png učitava), a `object-contain` unutra garantuje da se stvarni
// fajl (kakav god bio njegov pravi aspect ratio) skalira BEZ izobličenja.
// "lg" (login hero) ostaje fluidno (clamp) kao i dosadašnji TableCoreLogo —
// ostale veličine su fiksne jer žive u fiksnoj chrome visini (sidebar/header).
const DIMENSION_CLASS: Record<Variant, Record<Size, string>> = {
  mark: {
    sm: "h-6 w-6",
    md: "h-8 w-8",
    lg: "h-[clamp(3rem,12vw,3.5rem)] w-[clamp(3rem,12vw,3.5rem)]",
    xl: "h-16 w-16",
  },
  full: {
    sm: "h-6 w-28",
    md: "h-8 w-36",
    lg: "h-[clamp(3.25rem,15vw,3.75rem)] w-[clamp(10rem,45vw,14rem)]",
    xl: "h-16 w-64",
  },
  wordmark: {
    sm: "h-5 w-24",
    md: "h-6 w-28",
    lg: "h-[clamp(1.5rem,7vw,1.75rem)] w-[clamp(7rem,30vw,9rem)]",
    xl: "h-10 w-48",
  },
};

const OBJECT_POSITION: Record<Variant, string> = {
  mark: "center",
  full: "left center",
  wordmark: "left center",
};

/**
 * Centralni prikaz TableCore branding-a (naš POS PROIZVOD) — NIJE logo
 * pojedinačnog restorana koji koristi TableCore (to ostaje odvojen,
 * kasnije-konfigurabilan koncept po restoranu, npr. na računu). Zameni
 * `public/branding/app-logo.png` da promeniš logo SVUDA u aplikaciji, bez
 * diranja koda — vidi README "Global App Logo".
 *
 * Ako app-logo.png (privremeno) ne postoji ili ne uspe da se učita, tiho
 * prelazi na postojeći TableCoreLogo SVG (koji ne zavisi od spoljnog
 * fajla) — branding asset koji nedostaje NIKAD ne sme da obori ekran.
 */
export function AppLogo({ variant = "full", theme = "light", size = "md", className = "" }: AppLogoProps) {
  const [imageFailed, setImageFailed] = useState(false);

  if (imageFailed) {
    return <TableCoreLogo variant={variant} theme={theme} size={size} className={className} />;
  }

  return (
    <span
      role="img"
      aria-label={APP_NAME}
      className={`relative inline-block shrink-0 ${DIMENSION_CLASS[variant][size]} ${className}`}
    >
      <Image
        src="/branding/app-logo.png"
        alt={APP_NAME}
        fill
        sizes="256px"
        style={{ objectFit: "contain", objectPosition: OBJECT_POSITION[variant] }}
        priority={size === "lg"}
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}
