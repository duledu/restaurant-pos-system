/**
 * P3.1 — čista logika (bez DOM/React zavisnosti) izvučena iz PWA komponenti
 * da bi mogla biti unit-testirana bez jsdom/RTL, koje ovaj projekat namerno
 * ne koristi za unit testove (vidi vitest.config.ts — environment: "node").
 */

export const OFFLINE_MESSAGE =
  "Nema internet veze. TableCore zahteva vezu sa serverom za rad sa porudžbinama i naplatom.";

/** Da li je stranica trenutno pokrenuta kao instalirana (standalone) PWA. */
export function isStandaloneDisplay(input: { matchesStandaloneMediaQuery: boolean; iosStandalone?: boolean }): boolean {
  return input.matchesStandaloneMediaQuery || input.iosStandalone === true;
}

/**
 * Da li treba prikazati "Instaliraj aplikaciju" afordans — SAMO kad je
 * browser stvarno signalizirao da je instalacija dostupna (beforeinstallprompt
 * je uhvaćen) i aplikacija još nije instalirana. Nikad se ne pretpostavlja
 * podrška (specifikacija #13/#14) — ako `hasDeferredPrompt` nikad ne postane
 * `true` (npr. Safari/iOS), CTA se nikad ne prikazuje.
 */
export function canShowInstallCta(input: { isInstalled: boolean; hasDeferredPrompt: boolean }): boolean {
  return !input.isInstalled && input.hasDeferredPrompt;
}
