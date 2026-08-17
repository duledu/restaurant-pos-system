/**
 * Centralizovano formatiranje novca — zahtev Faze 5: ne rasipati "RSD" po
 * desetinama komponenti. Podrazumevana valuta ostaje RSD (Restaurant.currency
 * već postoji u šemi za budući multi-currency slučaj), ali svaki poziv može
 * proslediti drugu.
 *
 * Namerno NIJE Intl.NumberFormat(locale, { style: "currency", currency })
 * — RSD/manje uobičajene valute nemaju dosledan simbol/poziciju kroz sve
 * Node/browser Intl implementacije, a mi svakako želimo "1.234,56 RSD"
 * format (broj + kod valute), ne lokalizovani simbol.
 */

const DEFAULT_CURRENCY = "RSD";
const DEFAULT_LOCALE = "sr-RS";

export function formatMoney(amount: number | string, currency: string = DEFAULT_CURRENCY): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  const formatted = new Intl.NumberFormat(DEFAULT_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
  return `${formatted} ${currency}`;
}

/** Isti broj, bez koda valute — za kompaktne kartice gde je valuta već jasna iz konteksta. */
export function formatNumber(amount: number | string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}
