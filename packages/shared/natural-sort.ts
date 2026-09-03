/**
 * Prirodno ("numeric-aware") poređenje stringova — "Sto 2" ide PRE "Sto 10",
 * ne posle njega kao pri običnom leksikografskom (string) poređenju koje bi
 * uporedilo karakter-po-karakter ("1" < "2", pa "Sto 10" < "Sto 2"). Koristi
 * `Intl.Collator`/`localeCompare` sa `numeric: true` (standardna, ugrađena
 * podrška — bez ručnog parsiranja cifara) tako da bezbedno radi i za imena
 * koja NISU čisto brojevi ("Baštа 3", "VIP", "Sto 2B").
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function sortByLabelNatural<T extends { label: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => naturalCompare(a.label, b.label));
}
