"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MAX_PIN_LENGTH = 6;
const MIN_PIN_LENGTH = 4;
const FLASH_MS = 130;

type KeyId = (typeof KEYS)[number] | "0" | "backspace" | "submit";

interface PinPadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

// Raspon 50-100ms — brzo, opipljivo, bez primetnog kašnjenja pri brzom unosu.
const PRESS_TRANSITION = "transition-[transform,box-shadow,background-color] duration-75 ease-out";
const RAISED_SHADOW = "shadow-[0_3px_0_rgba(255,255,255,0.05),0_8px_18px_rgba(0,0,0,0.25)]";
const KEY_BASE = `relative min-h-[72px] select-none rounded-lg border border-white/15 bg-white/[0.07] text-3xl font-semibold tabular-nums text-white ${RAISED_SHADOW} ${PRESS_TRANSITION} hover:border-white/25 hover:bg-white/[0.11] active:translate-y-[2px] active:bg-white/[0.14] active:shadow-[0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.3)] disabled:opacity-40 disabled:active:translate-y-0 disabled:active:shadow-[0_3px_0_rgba(255,255,255,0.06),0_5px_10px_rgba(0,0,0,0.35)] disabled:active:bg-white/[0.06]`;
const CONFIRM_BASE = `relative flex items-center justify-center min-h-[72px] select-none rounded-lg border border-cream-300/30 bg-gold text-3xl font-semibold text-white shadow-[0_3px_0_rgba(255,255,255,0.12),0_8px_18px_rgba(0,0,0,0.3)] ${PRESS_TRANSITION} hover:bg-gold-dark active:translate-y-[2px] active:bg-gold-dark active:shadow-[0_1px_0_rgba(255,255,255,0.1),0_1px_3px_rgba(0,0,0,0.35)] disabled:opacity-40 disabled:active:translate-y-0`;

// Programsko "utisnuto" stanje za pritisak sa fizičke tastature — :active
// pseudoklasa ne reaguje na keydown, pa se isti vizuelni efekat primenjuje
// preko inline style-a (viši prioritet od Tailwind klasa, garantovano
// pobeđuje bez obzira na redosled generisanog CSS-a).
const KEYBOARD_PRESS_STYLE: CSSProperties = {
  transform: "translateY(2px)",
  boxShadow: "0 1px 0 rgba(255,255,255,0.04), 0 1px 3px rgba(0,0,0,0.3)",
  backgroundColor: "rgba(255,255,255,0.14)",
};
const KEYBOARD_PRESS_STYLE_CONFIRM: CSSProperties = {
  transform: "translateY(2px)",
  boxShadow: "0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.35)",
  backgroundColor: "#1A3D63",
};

/**
 * Veliki dodirni PIN taster za deljene restoranske ekrane — bez fizičke
 * tastature, sa opipljivim efektom pritiska (raised -> pressed -> raised)
 * za miš, dodir i fizičku numeričku tastaturu podjednako.
 */
export function PinPad({ value, onChange, onSubmit, disabled }: PinPadProps) {
  const [pressedKey, setPressedKey] = useState<KeyId | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flash(key: KeyId) {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setPressedKey(key);
    flashTimer.current = setTimeout(() => setPressedKey(null), FLASH_MS);
  }

  function pressDigit(d: string) {
    if (disabled || value.length >= MAX_PIN_LENGTH) return;
    onChange(value + d);
  }
  function pressBackspace() {
    if (disabled) return;
    onChange(value.slice(0, -1));
  }

  const canSubmit = !disabled && value.length >= MIN_PIN_LENGTH && value.length <= MAX_PIN_LENGTH;

  // Fizička tastatura (0-9, Backspace, Enter) radi identično kao dodirni
  // tasteri, sa istim kratkim vizuelnim "utiskom" na odgovarajućem dugmetu —
  // fizički i ekranski taster ostaju sinhronizovani.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        pressDigit(e.key);
        flash(e.key as KeyId);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        pressBackspace();
        flash("backspace");
      } else if (e.key === "Enter") {
        e.preventDefault();
        flash("submit");
        if (canSubmit) onSubmit();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled, canSubmit, onChange, onSubmit]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  return (
    <div className="w-full max-w-[340px]">
      <div className="mb-5 rounded-lg border border-white/10 bg-black/10 px-4 py-4">
      <p className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-300/55">Unesite PIN</p>
      <div className="flex justify-center gap-3" aria-live="polite" aria-label="Uneti PIN">
        {Array.from({ length: MAX_PIN_LENGTH }).map((_, i) => {
          const filled = i < value.length;
          const isLatest = filled && i === value.length - 1;
          return (
            <span
              key={isLatest ? `${i}-${value.length}` : i}
              className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${
                filled ? "border-gold bg-gold" : "border-white/25 bg-transparent"
              } ${isLatest ? "animate-dot-pop" : ""}`}
            />
          );
        })}
      </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => pressDigit(k)}
            style={pressedKey === k ? KEYBOARD_PRESS_STYLE : undefined}
            className={KEY_BASE}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || value.length === 0}
          onClick={pressBackspace}
          aria-label="Obriši cifru"
          style={pressedKey === "backspace" ? KEYBOARD_PRESS_STYLE : undefined}
          className={`${KEY_BASE} text-2xl text-white/80`}
        >
          <span aria-hidden="true">⌫</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => pressDigit("0")}
          style={pressedKey === "0" ? KEYBOARD_PRESS_STYLE : undefined}
          className={KEY_BASE}
        >
          0
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          aria-label="Potvrdi PIN"
          style={pressedKey === "submit" ? KEYBOARD_PRESS_STYLE_CONFIRM : undefined}
          className={CONFIRM_BASE}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
        </button>
      </div>
    </div>
  );
}
