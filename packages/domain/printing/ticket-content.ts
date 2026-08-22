/**
 * Faza 6 — čiste funkcije koje grade sadržaj tiketa/računa. Bez baze, bez
 * I/O — uzimaju već učitane podatke i vraćaju strukturiran JSON koji se
 * zamrzava u PrintJob.content (nikad se ne preračunava pri ponovnoj štampi,
 * ista konvencija kao Receipt — vidi schema.prisma).
 *
 * Kuhinjski/šank tiket NAMERNO ne sadrži cenu/ukupan iznos/podatke o
 * plaćanju (zahtev specifikacije #2/#3) — priprema ne treba da zna cenu.
 */

export type Station = "KITCHEN" | "BAR";

export function stationLabelFor(station: Station): string {
  return station === "KITCHEN" ? "KUHINJA" : "ŠANK";
}

export interface TicketLineItem {
  quantity: number;
  name: string;
  note: string | null;
  // P3.2: već-formatiran prikaz svake izabrane opcije ("+ Kačkavalj" kad ima
  // dodatnu cenu, ili goli naziv opcije kad je cena 0 — npr. "Bez luka").
  // NAMERNO string[], ne {name,priceDelta}[]: kuhinjski/šank tiket ne sme
  // sadržati cenu (postojeće pravilo, vidi napomenu na vrhu fajla) — prefiks
  // "+" se određuje na osnovu CENE pri građenju tiketa (print-service.ts),
  // ne parsiranjem naziva (specifikacija #52 zabranjuje to).
  modifiers?: string[];
}

export interface KitchenBarTicketContent {
  kind: "KITCHEN" | "BAR";
  stationLabel: string;
  restaurantName: string;
  tableLabel: string;
  waiterName: string;
  orderNumber: string;
  submittedAt: string;
  items: TicketLineItem[];
  /** Rezervisano za buduću "DODATNA NARUDŽBINA" putanju (vidi Fazu 6 plan —
   * dodavanje stavki posle submit-a trenutno nije podržano nigde u sistemu,
   * ova zastavica postoji da tiket format ne mora da se menja kad se doda). */
  isAdditional: boolean;
}

export function buildKitchenBarTicketContent(params: {
  station: Station;
  restaurantName: string;
  tableLabel: string;
  waiterName: string;
  orderNumber: string;
  submittedAt: string;
  items: TicketLineItem[];
}): KitchenBarTicketContent {
  return {
    kind: params.station,
    stationLabel: stationLabelFor(params.station),
    restaurantName: params.restaurantName,
    tableLabel: params.tableLabel,
    waiterName: params.waiterName,
    orderNumber: params.orderNumber,
    submittedAt: params.submittedAt,
    items: params.items,
    isAdditional: false,
  };
}

export interface CancellationTicketContent {
  kind: "STORNO";
  stationLabel: string;
  tableLabel: string;
  orderNumber: string;
  voidedAt: string;
  items: { quantity: number; name: string; modifiers?: string[] }[];
  reasonLabel: string;
}

export function buildCancellationTicketContent(params: {
  station: Station;
  tableLabel: string;
  orderNumber: string;
  voidedAt: string;
  items: { quantity: number; name: string; modifiers?: string[] }[];
  reasonLabel: string;
}): CancellationTicketContent {
  return {
    kind: "STORNO",
    stationLabel: stationLabelFor(params.station),
    tableLabel: params.tableLabel,
    orderNumber: params.orderNumber,
    voidedAt: params.voidedAt,
    items: params.items,
    reasonLabel: params.reasonLabel,
  };
}

export interface ReceiptTicketItem {
  quantity: number;
  name: string;
  unitPrice: string;
  lineTotal: string;
  // P3.2: aditivna polja za prikaz razlomljene cene (osnovna + dodaci) na
  // računu (specifikacija #20) — nedostaju na računima izdatim pre P3.2,
  // renderer to tretira kao "bez dodataka" (basePrice pada nazad na unitPrice).
  basePrice?: string;
  modifiers?: { name: string; priceDelta: string }[];
}

export interface ReceiptTaxBreakdownEntry {
  taxRate: string;
  taxableAmount: string;
  taxAmount: string;
}

export interface ReceiptTicketContent {
  kind: "RECEIPT";
  restaurantName: string;
  restaurantLegalName: string | null;
  address: string | null;
  phone: string | null;
  taxIdNumber: string | null;
  legalNote: string;
  footerText: string | null;
  receiptNumber: number;
  orderNumber: string;
  tableLabel: string;
  waiterName: string;
  issuedAt: string;
  items: ReceiptTicketItem[];
  subtotal: string;
  taxTotal: string;
  taxBreakdown: ReceiptTaxBreakdownEntry[];
  discountAmount: string | null;
  total: string;
  currency: string;
  paymentMethod: "CASH" | "CARD";
  tenderedAmount: string;
  changeAmount: string;
}

export const DEFAULT_RECEIPT_LEGAL_NOTE = "Radni nalog – nije fiskalni račun";

export function buildReceiptTicketContent(params: {
  restaurantName: string;
  restaurantLegalName: string | null;
  address: string | null;
  phone: string | null;
  taxIdNumber: string | null;
  legalNote: string | null;
  footerText: string | null;
  receiptNumber: number;
  orderNumber: string;
  tableLabel: string;
  waiterName: string;
  issuedAt: string;
  items: ReceiptTicketItem[];
  subtotal: string;
  taxTotal: string;
  taxBreakdown: ReceiptTaxBreakdownEntry[];
  discountAmount: string | null;
  total: string;
  currency: string;
  paymentMethod: "CASH" | "CARD";
  tenderedAmount: string;
  changeAmount: string;
}): ReceiptTicketContent {
  return {
    kind: "RECEIPT",
    restaurantName: params.restaurantName,
    restaurantLegalName: params.restaurantLegalName,
    address: params.address,
    phone: params.phone,
    taxIdNumber: params.taxIdNumber,
    legalNote: params.legalNote ?? DEFAULT_RECEIPT_LEGAL_NOTE,
    footerText: params.footerText,
    receiptNumber: params.receiptNumber,
    orderNumber: params.orderNumber,
    tableLabel: params.tableLabel,
    waiterName: params.waiterName,
    issuedAt: params.issuedAt,
    items: params.items,
    subtotal: params.subtotal,
    taxTotal: params.taxTotal,
    taxBreakdown: params.taxBreakdown,
    discountAmount: params.discountAmount,
    total: params.total,
    currency: params.currency,
    paymentMethod: params.paymentMethod,
    tenderedAmount: params.tenderedAmount,
    changeAmount: params.changeAmount,
  };
}

export function shortOrderNumber(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}
