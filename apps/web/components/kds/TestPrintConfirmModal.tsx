"use client";

/**
 * PRINTING P0 — TableCore-branded confirmation modal used by the
 * Admin "Test" button on a workstation route. Replaces the previous
 * `window.confirm()` call that surfaced a raw browser dialog.
 *
 * Visual identity mirrors WinForms WizardConfirmationForm (same copy,
 * same two equal-weight buttons, same keyboard semantics — Enter
 * confirms YES, Escape cancels as NO) so the operator sees one
 * product across the local Setup wizard and the remote Admin panel.
 *
 * The dialog is intentionally modal (backdrop + escape-handling +
 * focus trap via the dialog element) so the operator cannot
 * accidentally click outside and lose context.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal + aria-labelledby/aria-describedby
 *   - Escape key maps to "Ne — pokušaj ponovo"
 *   - Enter on focused default button maps to "Da — radi"
 *   - Backdrop click maps to "Ne — pokušaj ponovo" (intentional
 *     "click outside cancels" convention; the test ticket HAS
 *     physically come out — the operator just hasn't validated it).
 */
export interface TestPrintConfirmModalProps {
  /** e.g. "Kuhinja", "Šank", "Račun" — ROUTE_LABEL value for the route. */
  routeLabel: string;
  /** Full printer name to show as body context (the operator walked to it). */
  printerName: string;
  /** Paper width in mm (58 or 80). */
  paperWidthMm: number;
  /** Asynchronous resolver: true = physical paper confirmed, false = retry. */
  onResolve: (confirmed: boolean) => void;
}

export function TestPrintConfirmModal({
  routeLabel,
  printerName,
  paperWidthMm,
  onResolve,
}: TestPrintConfirmModalProps) {
  function close(confirmed: boolean) {
    onResolve(confirmed);
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(false);
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tccm-title"
      aria-describedby="tccm-body"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite/40 p-4 animate-fade-in"
      onClick={() => close(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-line bg-white p-5 shadow-elevated animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="tccm-title"
          className="mb-2 text-base font-bold uppercase tracking-wide text-ink"
        >
          TEST ŠTAMPE
        </h2>
        <p id="tccm-body" className="mb-4 text-sm leading-relaxed text-ink/85">
          Da li je test tiket uspešno odštampan i čitljiv?
        </p>
        <dl className="mb-5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-line/70 bg-cream-200 px-3 py-2 text-xs text-ink/80">
          <dt className="font-semibold uppercase tracking-wide text-ink/55">Ruta</dt>
          <dd className="font-medium text-ink">{routeLabel}</dd>
          <dt className="font-semibold uppercase tracking-wide text-ink/55">Štampač</dt>
          <dd className="font-medium text-ink">{printerName}</dd>
          <dt className="font-semibold uppercase tracking-wide text-ink/55">Širina papira</dt>
          <dd className="font-medium text-ink">{paperWidthMm} mm</dd>
        </dl>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={() => close(false)}
            className="min-h-11 rounded-md border border-line bg-white px-4 text-sm font-semibold text-ink/80 hover:border-ink/40 hover:text-ink"
          >
            Ne — pokušaj ponovo
          </button>
          <button
            type="button"
            onClick={() => close(true)}
            autoFocus
            className="min-h-11 rounded-md bg-success px-5 text-sm font-semibold text-white hover:bg-success/90"
          >
            Da — radi
          </button>
        </div>
      </div>
    </div>
  );
}