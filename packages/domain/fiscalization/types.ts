/**
 * FISKALIZACIJA — SAMO PRIPREMA ARHITEKTURE (zahtev #10 iz TableCore master
 * specifikacije). Ovaj fajl je ČISTI interfejs sloj — bez I/O, bez
 * implementacije za pravog fiskalnog provajdera (izbor/sertifikacija
 * konkretnog provajdera — SEF/PFR/ESIR u Srbiji — je van obima ovog rada).
 * Ništa odavde se NE poziva iz billing-service.ts ili bilo kog drugog
 * aktivnog toka. Trenutna naplata i TableCore nefiskalni radni nalog (vidi
 * printing/ticket-content.ts DEFAULT_RECEIPT_LEGAL_NOTE) ostaju potpuno
 * nepromenjeni. Vidi provider.ts za fiscalization.enabled zastavicu
 * (podrazumevano i trenutno ISKLJUČIVO false) i placeholder provajder.
 */

export interface FiscalizationLineItem {
  name: string;
  quantity: number;
  unitPrice: string;
  taxLabel: string;
  totalAmount: string;
}

export interface FiscalizationPayment {
  method: "CASH" | "CARD";
  amount: string;
}

/**
 * `requestId` je STABILAN ključ (isti obrazac kao Order.idempotencyKey) —
 * nužan za bezbedno pomirenje (reconciliation) posle timeout-a. Fiskalni
 * uređaji/API-ji često nemaju pouzdan sinhroni odgovor: ponovljen zahtev sa
 * ISTIM requestId-jem mora vratiti ISTI fiskalni rezultat (nikad drugu
 * fiskalnu fakturu za istu prodaju), a prodaja se NIKAD ne sme fiskalizovati
 * dva puta samo zato što je prvi odgovor kasnio ili se izgubio u mreži.
 * NAPOMENA: ne generisati requestId za današnje obične (nefiskalne)
 * transakcije — ovo polje postoji samo za budući fiskalni poziv koji se
 * danas nikad ne dešava.
 */
export interface FiscalizationInvoiceRequest {
  requestId: string;
  restaurantId: string;
  locationId: string;
  orderId: string;
  paymentId: string;
  receiptId: string;
  issuedAt: string;
  cashier: string;
  buyerId?: string;
  buyerCostCenterId?: string;
  invoiceType: string;
  transactionType: string;
  items: FiscalizationLineItem[];
  payments: FiscalizationPayment[];
  subtotal: string;
  taxTotal: string;
  total: string;
  currency: string;
  /** Popunjeno SAMO za refund — referenca na originalnu fiskalnu fakturu. */
  referenceInvoiceNumber?: string;
}

export type FiscalizationResultStatus = "FISCALIZED" | "FAILED" | "PENDING_RECONCILIATION";

/**
 * Sva polja osim requestId/status su OPCIONA i namerno bez ijedne
 * podrazumevane/izmišljene vrednosti bilo gde u kodu — dok pravi provajder
 * ne postoji, ni jedno od ovih polja se NIKAD ne popunjava (vidi
 * NoopFiscalizationProvider u provider.ts, koji baca grešku umesto da
 * fabrikuje uspešan odgovor).
 */
export interface FiscalizationResult {
  requestId: string;
  status: FiscalizationResultStatus;
  invoiceNumber?: string;
  invoiceCounter?: string;
  sdcDateTime?: string;
  verificationUrl?: string;
  qrPayload?: string;
  journal?: string;
  providerStatus?: string;
  failureReason?: string;
}

export interface FiscalizationHealth {
  reachable: boolean;
  detail?: string;
}

/**
 * Namerne, odvojene metode (umesto jedne generičke `fiscalize`) —
 * createInvoice/refundInvoice su različiti poslovni koncepti (VOID/CANCEL
 * u TableCore-u OSTAJE potpuno nezavisan od budućeg fiskalnog refund-a,
 * vidi provider.ts), a healthCheck/getStatus postoje ZA reconciliation
 * (isti requestId, siguran ponovljen upit posle timeout-a), ne za samu
 * fiskalizaciju prodaje.
 */
export interface FiscalizationProvider {
  createInvoice(request: FiscalizationInvoiceRequest): Promise<FiscalizationResult>;
  refundInvoice(request: FiscalizationInvoiceRequest): Promise<FiscalizationResult>;
  healthCheck(): Promise<FiscalizationHealth>;
  getStatus(requestId: string): Promise<FiscalizationResult>;
}
