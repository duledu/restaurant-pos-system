/**
 * BRANDED QR MENU V1 — pure theme resolution, shared by the public guest
 * menu AND the Admin live preview (same function, same output — never two
 * separate rendering/theme implementations, see spec section 8).
 *
 * Controlled customization, not a page builder: restaurants pick a theme
 * PRESET (curated palette) and, optionally, ONE accent color — never
 * arbitrary background/text combinations. If an accent is set, its
 * "on-accent" text color (e.g. a CTA label) is DERIVED via WCAG relative
 * luminance, never trusted as user input — this is the "automatically
 * derive safe text colors" approach from spec section 27, the simplest
 * robust option that can never produce unreadable text.
 */

export type QrThemePreset = "LIGHT" | "DARK" | "WARM" | "ELEGANT";
export type QrTypographyPreset = "ELEGANT" | "MODERN" | "CLASSIC" | "CASUAL";
export type QrCardStyle = "IMAGE_DOMINANT" | "BALANCED" | "COMPACT";
export type QrImageShape = "ROUNDED" | "SOFT" | "SQUARE";

export interface QrMenuThemeInput {
  themePreset: QrThemePreset;
  accentColor: string | null;
  typographyPreset: QrTypographyPreset;
  cardStyle: QrCardStyle;
  imageShape: QrImageShape;
}

export interface QrMenuThemeTokens {
  "--menu-primary": string;
  "--menu-on-primary": string;
  "--menu-background": string;
  "--menu-surface": string;
  "--menu-text": string;
  "--menu-muted": string;
  "--menu-border": string;
  "--menu-radius": string;
}

interface Palette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  defaultAccent: string;
}

const PALETTES: Record<QrThemePreset, Palette> = {
  LIGHT: { background: "#FFFFFF", surface: "#F7F7F8", text: "#18181B", muted: "#71717A", border: "#E4E4E7", defaultAccent: "#111827" },
  DARK: { background: "#181714", surface: "#22211D", text: "#F4EEE3", muted: "#B3AC9E", border: "#39362F", defaultAccent: "#C7A779" },
  WARM: { background: "#FBF6EE", surface: "#FFFFFF", text: "#2B2118", muted: "#756653", border: "#E9DCC3", defaultAccent: "#B8860B" },
  ELEGANT: { background: "#F7F3EE", surface: "#FFFFFF", text: "#1F1B16", muted: "#786C5A", border: "#E3D9C8", defaultAccent: "#8B6D3F" },
};

const RADIUS_BY_IMAGE_SHAPE: Record<QrImageShape, string> = {
  ROUNDED: "18px",
  SOFT: "10px",
  SQUARE: "2px",
};

/** Display font per typography preset — body text always stays on a neutral, highly-legible system stack (see PUBLIC_MENU_FONT_STACKS in the client). */
export const TYPOGRAPHY_DISPLAY_FONT: Record<QrTypographyPreset, string> = {
  ELEGANT: "Playfair Display",
  MODERN: "Poppins",
  CLASSIC: "Merriweather",
  CASUAL: "Quicksand",
};

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Safe on-accent text color (black or white) — never fails, falls back to white for a malformed hex rather than throwing (a public menu must never crash on bad stored input). */
function onColorFor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#FFFFFF";
  return relativeLuminance(rgb) > 0.45 ? "#111111" : "#FFFFFF";
}

function isValidHex(value: string | null): value is string {
  return value !== null && hexToRgb(value) !== null;
}

export function resolveQrMenuTheme(input: QrMenuThemeInput): QrMenuThemeTokens {
  const palette = PALETTES[input.themePreset] ?? PALETTES.WARM;
  const accent = isValidHex(input.accentColor) ? input.accentColor : palette.defaultAccent;
  return {
    "--menu-primary": accent,
    "--menu-on-primary": onColorFor(accent),
    "--menu-background": palette.background,
    "--menu-surface": palette.surface,
    "--menu-text": palette.text,
    "--menu-muted": palette.muted,
    "--menu-border": palette.border,
    "--menu-radius": RADIUS_BY_IMAGE_SHAPE[input.imageShape] ?? RADIUS_BY_IMAGE_SHAPE.ROUNDED,
  };
}
