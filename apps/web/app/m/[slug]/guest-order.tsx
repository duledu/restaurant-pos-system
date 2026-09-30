"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { GuestDraftItem } from "../../../lib/guest-order-draft";
import styles from "./guest-order.module.css";

const PRICE_FORMAT = new Intl.NumberFormat("sr-RS", { maximumFractionDigits: 2 });
function money(value: number | string) {
  const n = Number(value);
  return Number.isFinite(n) ? PRICE_FORMAT.format(n) : String(value);
}

export interface GuestOrderingLayerProps {
  slug: string;
  restaurantName: string;
  orderingMode: boolean;
  setOrderingMode: (on: boolean) => void;
  draft: {
    items: GuestDraftItem[];
    setQuantity: (menuItemId: string, index: number, quantity: number) => void;
    removeItem: (index: number) => void;
    setNote: (index: number, note: string) => void;
    clear: () => void;
    itemCount: number;
    totalPrice: number;
    maxNoteLength: number;
  };
}

interface FinalizeResult {
  token: string;
  expiresAt: string;
  itemCount: number;
  totalPrice: string;
}

async function finalize(slug: string, items: GuestDraftItem[]): Promise<FinalizeResult> {
  const res = await fetch("/api/public/qr-menu/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      items: items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, note: i.note.trim() || undefined })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error ?? `Greška (${res.status})`) as Error & { unavailableItemIds?: string[] };
    error.unavailableItemIds = body.unavailableItemIds;
    throw error;
  }
  return body as FinalizeResult;
}

function Stepper({ value, max, onChange }: { value: number; max: number; onChange: (next: number) => void }) {
  return (
    <div className={styles.stepper}>
      <button type="button" aria-label="Smanji količinu" onClick={() => onChange(value - 1)}>−</button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="Povećaj količinu" disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

function ReviewSheet({
  slug,
  draft,
  onClose,
  onFinalized,
}: {
  slug: string;
  draft: GuestOrderingLayerProps["draft"];
  onClose: () => void;
  onFinalized: (result: FinalizeResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await finalize(slug, draft.items);
      onFinalized(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.overlay}
      onClick={onClose}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-review-title"
      tabIndex={-1}
    >
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sheetHeader}>
          <h2 id="guest-review-title">Tvoja porudžbina</h2>
          <button type="button" aria-label="Zatvori" autoFocus onClick={onClose}>✕</button>
        </div>
        <div className={styles.sheetBody}>
          {draft.items.length === 0 ? (
            <p className={styles.empty}>Porudžbina je prazna.</p>
          ) : (
            <ul className={styles.reviewList}>
              {draft.items.map((item, index) => (
                <li key={`${item.menuItemId}-${index}`} className={styles.reviewRow}>
                  <div className={styles.reviewRowTop}>
                    <span className={styles.reviewName}>{item.name}</span>
                    <span className={styles.reviewLineTotal}>{money(Number(item.price) * item.quantity)} RSD</span>
                  </div>
                  <div className={styles.reviewRowControls}>
                    <Stepper value={item.quantity} max={20} onChange={(next) => draft.setQuantity(item.menuItemId, index, next)} />
                    <button type="button" className={styles.removeLink} onClick={() => draft.removeItem(index)}>Ukloni</button>
                  </div>
                  <input
                    type="text"
                    value={item.note}
                    onChange={(e) => draft.setNote(index, e.target.value)}
                    placeholder="Napomena (npr. bez luka)"
                    maxLength={draft.maxNoteLength}
                    className={styles.noteInput}
                  />
                </li>
              ))}
            </ul>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </div>
        {draft.items.length > 0 && (
          <div className={styles.sheetFooter}>
            <div className={styles.sheetTotal}>
              <span>{draft.itemCount} {draft.itemCount === 1 ? "artikal" : "artikla"}</span>
              <span>{money(draft.totalPrice)} RSD</span>
            </div>
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={submit}>
              {busy ? "Kreiranje…" : "ZAVRŠI PORUDŽBINU"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FinalizeResultSheet({ result, restaurantName, onClose, onEdit }: { result: FinalizeResult; restaurantName: string; onClose: () => void; onEdit: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const minutesLeft = Math.max(0, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60000));

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(result.token, { width: 320, margin: 1 }).then((url) => { if (!cancelled) setDataUrl(url); });
    return () => { cancelled = true; };
  }, [result.token]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="guest-result-title" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sheetHeader}>
          <h2 id="guest-result-title">Porudžbina je spremna</h2>
          <button type="button" aria-label="Zatvori" onClick={onClose}>✕</button>
        </div>
        <div className={`${styles.sheetBody} ${styles.resultBody}`}>
          <p className={styles.resultLead}>Pokažite ovaj QR kod konobaru — {restaurantName}</p>
          <div className={styles.qrFrame}>
            {/* eslint-disable-next-line @next/next/no-img-element -- locally-generated data: URL, next/image doesn't apply */}
            {dataUrl && <img src={dataUrl} alt="QR kod porudžbine" width={240} height={240} />}
          </div>
          <div className={styles.resultSummary}>
            <span>{result.itemCount} {result.itemCount === 1 ? "artikal" : "artikla"}</span>
            <span>{money(result.totalPrice)} RSD</span>
          </div>
          <p className={styles.resultExpiry}>Važi još {minutesLeft} min.</p>
          <button type="button" className={styles.secondaryButton} onClick={onEdit}>Izmeni porudžbinu</button>
        </div>
      </div>
    </div>
  );
}

export function GuestOrderingLayer({ slug, restaurantName, orderingMode, setOrderingMode, draft }: GuestOrderingLayerProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [result, setResult] = useState<FinalizeResult | null>(null);

  if (result) {
    return (
      <FinalizeResultSheet
        result={result}
        restaurantName={restaurantName}
        onClose={() => setResult(null)}
        onEdit={() => { setResult(null); setReviewOpen(true); }}
      />
    );
  }

  if (!orderingMode && draft.items.length === 0) {
    return (
      <button type="button" className={styles.cta} onClick={() => setOrderingMode(true)}>
        + Kreiraj porudžbinu
      </button>
    );
  }

  return (
    <>
      {draft.itemCount > 0 && !reviewOpen && (
        <button type="button" className={styles.stickySummary} onClick={() => setReviewOpen(true)}>
          <span>Porudžbina · {draft.itemCount} {draft.itemCount === 1 ? "artikal" : "artikla"} · {money(draft.totalPrice)} RSD</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
      {draft.itemCount === 0 && orderingMode && (
        <button type="button" className={styles.cta} onClick={() => setOrderingMode(false)}>
          Otkaži porudžbinu
        </button>
      )}
      {reviewOpen && (
        <ReviewSheet
          slug={slug}
          draft={draft}
          onClose={() => setReviewOpen(false)}
          // Deliberately does NOT clear the draft — "Izmeni porudžbinu"
          // (FinalizeResultSheet.onEdit) must return the guest to an
          // EDITABLE version of exactly what they just finalized (spec),
          // not an empty cart. The draft stays in sync with "what was last
          // finalized" until the guest actually changes it.
          onFinalized={(r) => { setReviewOpen(false); setResult(r); }}
        />
      )}
    </>
  );
}
