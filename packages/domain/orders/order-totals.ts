import { Prisma } from "@rcs/db";

export interface OrderTotalsLine {
  price: Prisma.Decimal | string | number;
  taxRate: Prisma.Decimal | string | number;
  quantity: number;
}

export interface TaxBreakdownEntry {
  taxRate: string;
  taxableAmount: string;
  taxAmount: string;
}

export interface OrderTotals {
  subtotal: Prisma.Decimal;
  tax: Prisma.Decimal;
  total: Prisma.Decimal;
  taxBreakdown: TaxBreakdownEntry[];
}

/**
 * Jedini izvor istine za novac na porudžbini. Sabira SAMO price/taxRate/quantity
 * snapshot vrednosti sa OrderItem redova (zamrznute pri dodavanju/slanju) —
 * nikad ne prihvata iznos poslat sa klijenta. Zaokruživanje na 2 decimale se
 * radi TEK na kraju (posle sabiranja svih stavki), ne po stavci, da se
 * izbegne akumulacija grešaka zaokruživanja kroz veliki broj stavki.
 */
export function computeOrderTotals(lines: OrderTotalsLine[]): OrderTotals {
  let subtotal = new Prisma.Decimal(0);
  let tax = new Prisma.Decimal(0);
  const byRate = new Map<string, { taxable: Prisma.Decimal; tax: Prisma.Decimal }>();

  for (const line of lines) {
    const price = new Prisma.Decimal(line.price);
    const taxRate = new Prisma.Decimal(line.taxRate);
    const lineSubtotal = price.mul(line.quantity);
    const lineTax = lineSubtotal.mul(taxRate).div(100);

    subtotal = subtotal.add(lineSubtotal);
    tax = tax.add(lineTax);

    const key = taxRate.toString();
    const bucket = byRate.get(key) ?? { taxable: new Prisma.Decimal(0), tax: new Prisma.Decimal(0) };
    bucket.taxable = bucket.taxable.add(lineSubtotal);
    bucket.tax = bucket.tax.add(lineTax);
    byRate.set(key, bucket);
  }

  subtotal = subtotal.toDecimalPlaces(2);
  tax = tax.toDecimalPlaces(2);
  const total = subtotal.add(tax);

  const taxBreakdown = Array.from(byRate.entries())
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([taxRate, bucket]) => ({
      taxRate,
      taxableAmount: bucket.taxable.toDecimalPlaces(2).toString(),
      taxAmount: bucket.tax.toDecimalPlaces(2).toString(),
    }));

  return { subtotal, tax, total, taxBreakdown };
}
