"use client";

/**
 * P0 GUEST QR ORDERING — waiter-side scan -> review -> claim -> import.
 *
 * SCAN != CLAIM: opening the camera and decoding a QR only calls the
 * read-only REVIEW endpoint (never mutates anything server-side). Only the
 * explicit "DODAJ NA STO" confirmation calls CLAIM (the one mutating step),
 * and only after a successful claim does this component call `onImport`,
 * which the parent (OrderClient) wires to the EXISTING
 * addItemWithModifiers/Instant Local Draft path — nothing here ever creates
 * an Order/OrderItem/KDS/PrintJob itself.
 *
 * jsQR (not the native BarcodeDetector) is used uniformly across browsers
 * for predictable behavior — BarcodeDetector support is inconsistent
 * (absent in Firefox/Safari, varies by Android Chrome version); one small
 * (~40KB, zero-dependency) pure-JS decoder avoids browser-specific
 * branching for a feature that must work reliably on the actual devices
 * waiters carry. Lazy-imported (see openScanner) so it never bloats the
 * initial waiter-shell bundle.
 */
import { useEffect, useRef, useState } from "react";

export interface ScannedGuestOrderItem {
  menuItemId: string;
  name: string;
  price: string;
  quantity: number;
  note: string | null;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
}
interface GuestOrderSnapshot {
  itemCount: number;
  totalPrice: string;
  items: ScannedGuestOrderItem[];
}

const PRICE_FORMAT = new Intl.NumberFormat("sr-RS", { maximumFractionDigits: 2 });
function money(value: string | number) {
  const n = Number(value);
  return Number.isFinite(n) ? PRICE_FORMAT.format(n) : String(value);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Greška (${res.status})`);
  return json as T;
}

type ScanState =
  | { phase: "camera" }
  | { phase: "camera-error"; message: string }
  | { phase: "reviewing"; token: string; snapshot: GuestOrderSnapshot }
  | { phase: "review-error"; message: string }
  | { phase: "claiming" }
  | { phase: "claim-error"; message: string };

function CameraView({ onDecoded, onError }: { onDecoded: (token: string) => void; onError: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const decodedRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    async function start() {
      try {
        const jsQR = (await import("jsqr")).default;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const videoEl = videoRef.current;
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await videoEl.play();

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        function tick() {
          if (cancelled || decodedRef.current) return;
          // videoEl was already null-checked above (line 74); it's a stable
          // React ref for the lifetime of this effect, so this non-null
          // assertion reflects a real, already-verified invariant, not an
          // unchecked assumption.
          const video = videoEl!;
          if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = jsQR(imageData.data, imageData.width, imageData.height);
            if (result?.data && !decodedRef.current) {
              decodedRef.current = true; // guard: never trigger a second decode for the same session
              // Stop the camera the INSTANT a QR is detected — don't rely on
              // the parent's later state change + this effect's unmount
              // cleanup to get around to it. The video element still
              // unmounts right after (state moves off "camera"), but the
              // physical camera light/stream must go dark right here.
              cancelAnimationFrame(raf);
              stream?.getTracks().forEach((t) => t.stop());
              onDecoded(result.data);
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        }
        raf = requestAnimationFrame(tick);
      } catch (err) {
        const message = (err as DOMException)?.name === "NotAllowedError"
          ? "Pristup kameri je odbijen. Dozvolite pristup kameri u podešavanjima pregledača."
          : "Kamera nije dostupna na ovom uređaju.";
        onError(message);
      }
    }
    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDecoded/onError are stable closures from the parent for the lifetime of this mount
  }, []);

  return (
    <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-xl bg-black">
      <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/70" aria-hidden="true" />
    </div>
  );
}

export function GuestOrderScanner({ tableId, onImport }: { tableId: string; onImport: (items: ScannedGuestOrderItem[]) => Promise<{ importedLines: number; importedCount: number; failedCount: number; confirmed: boolean }> }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScanState>({ phase: "camera" });
  const [importResult, setImportResult] = useState<{ importedLines: number; importedCount: number; failedCount: number; confirmed: boolean } | null>(null);

  function close() {
    setOpen(false);
    setState({ phase: "camera" });
    setImportResult(null);
  }

  async function handleDecoded(token: string) {
    setState({ phase: "claiming" }); // brief neutral state while review resolves — avoids a flash back to the camera view
    try {
      const snapshot = await postJson<GuestOrderSnapshot>("/api/pos/guest-handoffs/review", { token });
      setState({ phase: "reviewing", token, snapshot });
    } catch (err) {
      setState({ phase: "review-error", message: (err as Error).message });
    }
  }

  async function confirmImport() {
    if (state.phase !== "reviewing") return;
    setState({ phase: "claiming" }); // stays shown while onImport awaits actual persistence, not just the local add
    try {
      const snapshot = await postJson<GuestOrderSnapshot>("/api/pos/guest-handoffs/claim", { token: state.token, tableId });
      const result = await onImport(snapshot.items);
      setImportResult(result);
    } catch (err) {
      setState({ phase: "claim-error", message: (err as Error).message });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-gold/40 bg-gold-soft px-3 text-xs font-semibold text-gold-dark hover:border-gold/60"
      >
        Skeniraj QR porudžbine
      </button>
      {open && (
        <div role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4">
          {/* svh (not vh) — same fix as guest-order.module.css .sheet: plain
              vh overestimates the visible height on a real mobile browser
              whose address bar hasn't collapsed yet, which clips/oversizes
              the modal exactly as reported from a physical Android device. */}
          <div className="flex max-h-[92svh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-elevated">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-base font-bold text-ink">
                {importResult ? "Dodato na sto" : state.phase === "reviewing" ? "Porudžbina gosta" : "Skeniranje QR koda"}
              </h2>
              <button onClick={close} autoFocus className="flex h-11 w-11 items-center justify-center text-ink/50 hover:text-ink" aria-label="Zatvori">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {importResult ? (
                <div className="py-6 text-center">
                  {importResult.confirmed ? (
                    <p className="text-sm text-ink">
                      {/* Disambiguates unique menu items from total quantity —
                          "4 stavke" previously conflated the two and looked
                          like data loss when e.g. Omlet x2 + 2 others (3
                          lines, 4 units) rendered as 3 order lines. */}
                      {importResult.importedLines === importResult.importedCount
                        ? <>{importResult.importedLines} {importResult.importedLines === 1 ? "stavka je dodata" : "stavki je dodato"} na sto.</>
                        : <>{importResult.importedLines} {importResult.importedLines === 1 ? "artikal" : "artikla"} dodato na sto — ukupno {importResult.importedCount} kom.</>}
                    </p>
                  ) : (
                    <p className="text-sm text-danger">
                      Potvrda čuvanja nije stigla za sve stavke. Proverite porudžbinu na stolu — ako nešto nedostaje, koristite „Pokušaj ponovo“ pored porudžbine.
                    </p>
                  )}
                  {importResult.failedCount > 0 && (
                    <p className="mt-2 text-sm text-danger">{importResult.failedCount} stavki nije moglo biti dodato — više nisu dostupne. Proverite meni.</p>
                  )}
                  <button onClick={close} className="mt-4 min-h-11 w-full rounded-md bg-gold px-4 text-sm font-bold text-white hover:bg-gold-dark">U redu</button>
                </div>
              ) : state.phase === "camera" ? (
                <div className="flex flex-col items-center gap-3">
                  <CameraView onDecoded={handleDecoded} onError={(message) => setState({ phase: "camera-error", message })} />
                  <p className="text-center text-xs text-ink/50">Usmerite kameru na QR kod gosta.</p>
                </div>
              ) : state.phase === "camera-error" ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-danger">{state.message}</p>
                  <button onClick={() => setState({ phase: "camera" })} className="mt-4 min-h-11 rounded-md border border-line px-4 text-sm font-medium text-ink hover:bg-cream-100">Pokušaj ponovo</button>
                </div>
              ) : state.phase === "claiming" ? (
                <p role="status" className="py-10 text-center text-sm text-inkSoft">Učitavanje…</p>
              ) : state.phase === "review-error" || state.phase === "claim-error" ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-danger">{state.message}</p>
                  <button onClick={() => setState({ phase: "camera" })} className="mt-4 min-h-11 rounded-md border border-line px-4 text-sm font-medium text-ink hover:bg-cream-100">Skeniraj ponovo</button>
                </div>
              ) : (
                <div>
                  <ul className="space-y-3">
                    {state.snapshot.items.map((item, index) => (
                      <li key={`${item.menuItemId}-${index}`} className="border-b border-line pb-3 last:border-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-ink">{item.name} ×{item.quantity}</span>
                          <span className="tabular-nums text-ink">{money(Number(item.price) * item.quantity)} RSD</span>
                        </div>
                        {item.note && <p className="mt-0.5 text-xs text-ink/55">Napomena: {item.note}</p>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3 text-sm font-bold text-ink">
                    <span>Ukupno</span>
                    <span className="tabular-nums">{money(state.snapshot.totalPrice)} RSD</span>
                  </div>
                </div>
              )}
            </div>
            {state.phase === "reviewing" && !importResult && (
              <div className="flex gap-2 border-t border-line p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <button onClick={close} className="min-h-11 flex-1 rounded-md border border-line text-sm font-medium text-ink hover:bg-cream-100">OTKAŽI</button>
                <button onClick={confirmImport} className="min-h-11 flex-1 rounded-md bg-gold text-sm font-bold text-white hover:bg-gold-dark">DODAJ NA STO</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
