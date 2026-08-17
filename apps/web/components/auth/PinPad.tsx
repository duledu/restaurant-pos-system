"use client";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MAX_PIN_LENGTH = 6;
const MIN_PIN_LENGTH = 4;

interface PinPadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

/**
 * Veliki dodirni PIN taster za deljene restoranske ekrane — bez fizičke
 * tastature, bez padajuće liste zaposlenih (PIN sam identifikuje zaposlenog,
 * vidi pin-login/route.ts), maskiran unos.
 */
export function PinPad({ value, onChange, onSubmit, disabled }: PinPadProps) {
  function pressDigit(d: string) {
    if (disabled || value.length >= MAX_PIN_LENGTH) return;
    onChange(value + d);
  }
  function pressBackspace() {
    if (disabled) return;
    onChange(value.slice(0, -1));
  }

  const canSubmit = !disabled && value.length >= MIN_PIN_LENGTH && value.length <= MAX_PIN_LENGTH;

  return (
    <div className="w-full max-w-xs">
      <div className="mb-6 flex justify-center gap-3" aria-live="polite" aria-label="Uneti PIN">
        {Array.from({ length: MAX_PIN_LENGTH }).map((_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${
              i < value.length ? "border-gold bg-gold" : "border-white/25 bg-transparent"
            }`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => pressDigit(k)}
            className="min-h-20 rounded-xl bg-white/[0.06] text-3xl font-semibold text-white transition-colors hover:bg-white/[0.12] active:bg-white/[0.18] disabled:opacity-40"
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || value.length === 0}
          onClick={pressBackspace}
          aria-label="Obriši cifru"
          className="min-h-20 rounded-xl bg-white/[0.06] text-2xl font-semibold text-white/80 transition-colors hover:bg-white/[0.12] active:bg-white/[0.18] disabled:opacity-40"
        >
          ←
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => pressDigit("0")}
          className="min-h-20 rounded-xl bg-white/[0.06] text-3xl font-semibold text-white transition-colors hover:bg-white/[0.12] active:bg-white/[0.18] disabled:opacity-40"
        >
          0
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          aria-label="Potvrdi PIN"
          className="min-h-20 rounded-xl bg-gold text-3xl font-semibold text-white transition-colors hover:bg-gold-dark disabled:opacity-40"
        >
          ✓
        </button>
      </div>
    </div>
  );
}
