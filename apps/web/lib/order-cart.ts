/**
 * P3.2 — čista logika za korpu konobara, izvučena iz order-client.tsx da bi
 * bila unit-testabilna bez DOM-a (isti razlog kao lib/pwa.ts).
 */

export interface SelectedModifierLike {
  modifierOptionId: string | null;
}

/**
 * Deterministička jednakost skupa izabranih dodataka — sortirano po ID-ju,
 * NE po redosledu klika/prikaza (specifikacija #47). Koristi se da odluči
 * da li tap na artikal treba da inkrementira POSTOJEĆI red korpe ili napravi
 * NOV (specifikacija #46): "Burger + sir" i "Burger + slanina" su UVEK
 * odvojeni redovi; dva tapa na "Burger + sir" (bez obzira na redosled
 * biranja "sir pa slanina" vs "slanina pa sir" NE važi ovde — to bi bio
 * drugačiji skup) inkrementiraju ISTI red.
 */
export function sameModifierSelection(existing: SelectedModifierLike[], selectedOptionIds: string[]): boolean {
  const a = existing.map((m) => m.modifierOptionId).filter((id): id is string => id !== null).sort();
  const b = [...selectedOptionIds].sort();
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
