"use client";

/**
 * Generic branded confirmation dialog — replaces native window.confirm()
 * wherever a destructive action needs a deliberate second step. Same
 * accessible-modal convention as TestPrintConfirmModal (role=dialog +
 * aria-modal + Escape-to-cancel + autoFocus on the safe default action).
 */
export interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, body, confirmLabel = "Potvrdi", cancelLabel = "Otkaži", danger = false, onConfirm, onCancel }: ConfirmModalProps) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-body"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-5 shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-modal-title" className="mb-1.5 text-base font-bold text-ink">{title}</h2>
        <p id="confirm-modal-body" className="mb-5 text-sm leading-relaxed text-ink/75">{body}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <button type="button" onClick={onCancel} autoFocus={!danger} className="min-h-11 rounded-md border border-line bg-white px-4 text-sm font-semibold text-ink/80 hover:border-ink/40 hover:text-ink">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus={danger}
            className={`min-h-11 rounded-md px-4 text-sm font-semibold text-white ${danger ? "bg-danger hover:opacity-90" : "bg-gold hover:bg-gold-dark"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
