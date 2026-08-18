"use client";

interface TicketItem {
  quantity: number;
  name: string;
  note?: string | null;
}

interface KitchenBarContent {
  kind: "KITCHEN" | "BAR";
  stationLabel: string;
  restaurantName: string;
  tableLabel: string;
  waiterName: string;
  orderNumber: string;
  submittedAt: string;
  items: TicketItem[];
}

interface StornoContent {
  kind: "STORNO";
  stationLabel: string;
  tableLabel: string;
  orderNumber: string;
  voidedAt: string;
  items: { quantity: number; name: string }[];
  reasonLabel: string;
}

interface ReceiptContent {
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
  items: { quantity: number; name: string; unitPrice: string; lineTotal: string }[];
  subtotal: string;
  taxTotal: string;
  discountAmount: string | null;
  total: string;
  currency: string;
  paymentMethod: "CASH" | "CARD";
  tenderedAmount: string;
  changeAmount: string;
}

export type TicketContent = KitchenBarContent | StornoContent | ReceiptContent;

const PAYMENT_LABEL: Record<"CASH" | "CARD", string> = { CASH: "GOTOVINA", CARD: "KARTICA" };

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sr-RS");
}

/**
 * Renderuje BILO KOJI PrintJob.content oblik — kuhinjski/šank tiket, STORNO,
 * ili kupčev račun. Uvek uvijeno u .print-ticket-root (vidi
 * print-thermal.css) tako da je van @media print nevidljivo/van ekrana —
 * ne oslanja se ni na jedan deo normalnog dashboard styling-a.
 */
function KitchenBarTicket({ content }: { content: KitchenBarContent }) {
  return (
    <>
      <div className="t-header">TABLECORE</div>
      <div className="t-station">{content.stationLabel}</div>
      <div className="t-meta">STO: {content.tableLabel}</div>
      <div className="t-meta">KONOBAR: {content.waiterName}</div>
      <div className="t-meta">NARUDŽBINA: #{content.orderNumber}</div>
      <div className="t-meta">VREME: {fmtTime(content.submittedAt)}</div>
      <hr className="t-sep" />
      {content.items.map((item, i) => (
        <div key={i}>
          <div className="t-item">
            <span className="t-item-qty">{item.quantity}x</span>
            <span style={{ flex: 1 }}>{item.name}</span>
          </div>
          {item.note && <div className="t-note">* {item.note}</div>}
        </div>
      ))}
      <hr className="t-sep" />
      <div className="t-footer">{fmtTime(content.submittedAt)}</div>
    </>
  );
}

function StornoTicket({ content }: { content: StornoContent }) {
  return (
    <>
      <div className="t-header">TABLECORE</div>
      <div className="t-station">STORNO — {content.stationLabel}</div>
      <div className="t-meta">STO: {content.tableLabel}</div>
      <div className="t-meta">NARUDŽBINA: #{content.orderNumber}</div>
      <div className="t-meta">VREME: {fmtTime(content.voidedAt)}</div>
      <hr className="t-sep" />
      <div className="t-meta" style={{ fontWeight: 700 }}>STORNIRATI:</div>
      {content.items.map((item, i) => (
        <div className="t-item" key={i}>
          <span className="t-item-qty">{item.quantity}x</span>
          <span style={{ flex: 1 }}>{item.name}</span>
        </div>
      ))}
      <div className="t-note">Razlog: {content.reasonLabel}</div>
      <hr className="t-sep" />
      <div className="t-footer">{fmtTime(content.voidedAt)}</div>
    </>
  );
}

function ReceiptTicket({ content }: { content: ReceiptContent }) {
  return (
    <>
      <div className="t-header">{content.restaurantName}</div>
      {content.restaurantLegalName && <div className="t-center">{content.restaurantLegalName}</div>}
      {content.address && <div className="t-center">{content.address}</div>}
      {content.phone && <div className="t-center">{content.phone}</div>}
      {content.taxIdNumber && <div className="t-center">PIB: {content.taxIdNumber}</div>}
      <hr className="t-sep" />
      <div className="t-meta">Račun #{content.receiptNumber}</div>
      <div className="t-meta">Sto: {content.tableLabel}</div>
      <div className="t-meta">Konobar: {content.waiterName}</div>
      <div className="t-meta">{fmtDateTime(content.issuedAt)}</div>
      <hr className="t-sep" />
      {content.items.map((item, i) => (
        <div className="t-line" key={i}>
          <span>{item.quantity}x {item.name}</span>
          <span>{Number(item.lineTotal).toFixed(2)}</span>
        </div>
      ))}
      <hr className="t-sep" />
      <div className="t-line"><span>Osnovica:</span><span>{Number(content.subtotal).toFixed(2)}</span></div>
      <div className="t-line"><span>PDV:</span><span>{Number(content.taxTotal).toFixed(2)}</span></div>
      {content.discountAmount && Number(content.discountAmount) > 0 && (
        <div className="t-line"><span>Popust:</span><span>-{Number(content.discountAmount).toFixed(2)}</span></div>
      )}
      <div className="t-total"><span>UKUPNO:</span><span>{Number(content.total).toFixed(2)} {content.currency}</span></div>
      <hr className="t-sep" />
      <div className="t-line"><span>Plaćanje:</span><span>{PAYMENT_LABEL[content.paymentMethod]}</span></div>
      {content.paymentMethod === "CASH" && (
        <>
          <div className="t-line"><span>Primljeno:</span><span>{Number(content.tenderedAmount).toFixed(2)}</span></div>
          <div className="t-line"><span>Kusur:</span><span>{Number(content.changeAmount).toFixed(2)}</span></div>
        </>
      )}
      <hr className="t-sep" />
      {content.footerText && <div className="t-footer">{content.footerText}</div>}
      <div className="t-footer">Hvala na poseti!</div>
      <div className="t-legal">{content.legalNote}</div>
    </>
  );
}

/**
 * Renderuje BILO KOJI PrintJob.content oblik — kuhinjski/šank tiket, STORNO,
 * ili kupčev račun. Uvek uvijeno u .print-ticket-root (vidi
 * print-thermal.css) tako da je van @media print nevidljivo/van ekrana —
 * ne oslanja se ni na jedan deo normalnog dashboard styling-a.
 */
export function TicketPrintPanel({ content }: { content: TicketContent }) {
  return (
    <div className="print-ticket-root">
      <div className="print-ticket">
        {content.kind === "STORNO" ? (
          <StornoTicket content={content} />
        ) : content.kind === "RECEIPT" ? (
          <ReceiptTicket content={content} />
        ) : (
          <KitchenBarTicket content={content} />
        )}
      </div>
    </div>
  );
}
