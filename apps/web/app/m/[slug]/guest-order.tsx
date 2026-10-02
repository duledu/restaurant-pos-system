"use client";

import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import type { GuestDraftItem } from "../../../lib/guest-order-draft";
import styles from "./guest-order.module.css";

const PRICE_FORMAT = new Intl.NumberFormat("sr-RS", { maximumFractionDigits: 2 });
function money(value: number | string) {
  const n = Number(value);
  return Number.isFinite(n) ? PRICE_FORMAT.format(n) : String(value);
}

// Local, self-contained — matches the existing project convention
// (public-menu-view.tsx also keeps its own private Icon fn rather than a
// shared icon module) for the one icon this file actually needs.
function BagIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 7h12l1 13.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20.5L6 7Z" />
      <path d="M9 10V6a3 3 0 0 1 6 0v4" />
    </svg>
  );
}

// Disambiguates unique menu lines ("artikala") from total quantity ("kom.")
// — physical QA showed a total-quantity count ("4 stavke") next to a
// unique-line count ("3 stavki") and it read as lost data. Only shows both
// numbers when they actually differ (i.e. any line has quantity > 1).
export function countLabel(lines: number, units: number): string {
  const artikli = lines === 1 ? "artikal" : "artikla";
  return lines === units ? `${lines} ${artikli}` : `${lines} ${artikli} · ${units} kom.`;
}

export interface GuestOrderingLayerProps {
  slug: string;
  restaurantName: string;
  orderingMode: boolean;
  setOrderingMode: (on: boolean) => void;
  draft: {
    items: GuestDraftItem[];
    changeQuantity: (menuItemId: string, index: number, delta: number) => void;
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
  items: unknown[];
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

// onChange takes a DELTA (-1/+1), never an absolute target — see
// changeQuantity in guest-order-draft.ts for why: resolving the target
// INSIDE the functional setItems updater (against whatever is actually
// current at apply time) is what keeps rapid repeated taps correct,
// instead of every queued tap computing the same stale "value ± 1".
function Stepper({ value, max, onChange }: { value: number; max: number; onChange: (delta: number) => void }) {
  return (
    <div className={styles.stepper}>
      <button type="button" aria-label="Smanji količinu" onClick={() => onChange(-1)}>−</button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="Povećaj količinu" disabled={value >= max} onClick={() => onChange(1)}>+</button>
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  // Native <dialog> — same proven pattern as ProductDetail
  // (public-menu-view.tsx): showModal gives a REAL focus trap and
  // Escape-as-cancel for free, instead of a hand-rolled keydown handler on
  // a styled div. onCancel intercepts Escape so we still control state
  // (setReviewOpen) rather than letting the dialog close itself first.
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

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
    <dialog
      ref={dialogRef}
      className={styles.sheet}
      aria-labelledby={headingId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.sheetHeader}>
        <h2 id={headingId}>Tvoja porudžbina</h2>
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
                  <Stepper value={item.quantity} max={20} onChange={(delta) => draft.changeQuantity(item.menuItemId, index, delta)} />
                  <button type="button" className={styles.removeLink} onClick={() => draft.removeItem(index)}>Ukloni</button>
                </div>
                <input
                  type="text"
                  value={item.note}
                  onChange={(e) => draft.setNote(index, e.target.value)}
                  placeholder="Napomena uz stavku (npr. bez luka)"
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
            <span>{countLabel(draft.items.length, draft.itemCount)}</span>
            <span>{money(draft.totalPrice)} RSD</span>
          </div>
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={submit}>
            {busy ? "Kreiranje…" : "ZAVRŠI PORUDŽBINU"}
          </button>
        </div>
      )}
    </dialog>
  );
}

const HANDOFF_POLL_MS = 4000;

function FinalizeResultSheet({ result, restaurantName, onClose, onEdit, onClaimed }: { result: FinalizeResult; restaurantName: string; onClose: (wasClaimed: boolean) => void; onEdit: () => void; onClaimed: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const minutesLeft = Math.max(0, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60000));
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(result.token, { width: 360, margin: 2 }).then((url) => { if (!cancelled) setDataUrl(url); });
    return () => { cancelled = true; };
  }, [result.token]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  // Guest claim lifecycle (final UX pass, new required behavior) — the
  // guest must learn the waiter actually accepted the order, not just that
  // a QR was shown. Lightweight polling while this sheet is open (sanctioned
  // over WebSockets for one short-lived screen); stops on claim, on expiry,
  // or on unmount — never after claimed is already true, never orphaned.
  useEffect(() => {
    if (claimed) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/public/qr-menu/handoff-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: result.token }) });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (body.status === "CLAIMED") { setClaimed(true); onClaimed(); }
        else if (body.status === "EXPIRED") { clearInterval(id); }
      } catch {
        // Transient network hiccup — the next tick retries; never surfaces an error for a background poll.
      }
    }, HANDOFF_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [result.token, claimed, onClaimed]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.sheet}
      aria-labelledby={headingId}
      onCancel={(e) => { e.preventDefault(); onClose(claimed); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(claimed); }}
    >
      <div className={styles.sheetHeader}>
        <h2 id={headingId}>{claimed ? "Porudžbinu je preuzeo konobar" : "Porudžbina je spremna"}</h2>
        <button type="button" aria-label="Zatvori" onClick={() => onClose(claimed)}>✕</button>
      </div>
      {claimed ? (
        <div className={`${styles.sheetBody} ${styles.resultBody}`}>
          <p className={styles.resultLead}>Porudžbina je uspešno predata. Možete nastaviti da pregledate meni ili napraviti novu porudžbinu.</p>
          <button type="button" className={styles.primaryButton} onClick={() => onClose(true)}>Nazad na meni</button>
        </div>
      ) : (
        <div className={`${styles.sheetBody} ${styles.resultBody}`}>
          <p className={styles.resultLead}>Pokažite ovaj QR kod konobaru — {restaurantName}</p>
          <div className={styles.qrFrame}>
            {/* eslint-disable-next-line @next/next/no-img-element -- locally-generated data: URL, next/image doesn't apply */}
            {dataUrl && <img src={dataUrl} alt="QR kod porudžbine" width={252} height={252} />}
          </div>
          <div className={styles.resultSummary}>
            <span>{countLabel(result.items.length, result.itemCount)}</span>
            <span>{money(result.totalPrice)} RSD</span>
          </div>
          <p className={styles.resultExpiry}>Važi još {minutesLeft} min.</p>
          <button type="button" className={styles.secondaryButton} onClick={onEdit}>Izmeni porudžbinu</button>
        </div>
      )}
    </dialog>
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
        onClose={(wasClaimed) => { setResult(null); if (wasClaimed) setOrderingMode(false); }}
        onEdit={() => { setResult(null); setReviewOpen(true); }}
        // Replay protection (server-side claim is already atomic/one-shot —
        // see claimGuestOrderHandoff) — this is the CLIENT half: once a
        // waiter has accepted it, the local draft it came from is done,
        // never resurrected by "Izmeni porudžbinu" or a later re-entry.
        onClaimed={() => draft.clear()}
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
      {/* ONE coherent premium order dock — not a split back/summary pill
          pair (physical QA explicitly rejected that pile-up), and not a
          second floating element fighting the nav-integrated "Poručivanje"
          control (public-menu-view.tsx) for the "exit ordering mode" job.
          This surface has exactly one job: show the order at a glance and
          open the review sheet. Visible whenever there's a draft to show,
          regardless of orderingMode, so a guest who stepped back to pure
          browsing can still reach/finalize an existing draft. */}
      {draft.itemCount > 0 && !reviewOpen && (
        <button type="button" className={styles.dock} onClick={() => setReviewOpen(true)}>
          <span className={styles.dockIcon} aria-hidden="true"><BagIcon /></span>
          <span className={styles.dockLabel}>
            <span className={styles.dockTitle}>Porudžbina</span>
            <span className={styles.dockCount}>{countLabel(draft.items.length, draft.itemCount)}</span>
          </span>
          <span className={styles.dockTotal}>
            <span className={styles.dockPrice}>{money(draft.totalPrice)} RSD</span>
            <span className={styles.dockArrow} aria-hidden="true">→</span>
          </span>
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
