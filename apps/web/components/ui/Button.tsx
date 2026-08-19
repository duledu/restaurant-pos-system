"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "dangerGhost";
type Size = "sm" | "md" | "lg";

const VARIANT_STYLES: Record<Variant, string> = {
  primary: "border border-gold bg-gold text-white shadow-sm hover:border-gold-dark hover:bg-gold-dark active:translate-y-px active:bg-graphite",
  secondary: "bg-white text-ink border border-line shadow-sm hover:border-gold/50 hover:bg-cream-200 active:translate-y-px",
  ghost: "text-inkSoft hover:bg-ink/5 hover:text-ink",
  danger: "bg-danger text-white hover:opacity-90",
  // Nizak-dominantnost tretman za rizične-ali-ne-primarne akcije (npr.
  // "Postavi sve na 0") — komunicira opasnost bojom, ne oduzima pažnju
  // solid crvenom površinom koja bi delovala kao primarno dugme na strani.
  dangerGhost: "bg-transparent text-danger border border-danger/30 hover:bg-danger/5",
};

const SIZE_STYLES: Record<Size, string> = {
  sm: "min-h-9 px-3 py-1.5 text-xs",
  md: "min-h-10 px-4 py-2 text-sm",
  lg: "min-h-12 px-6 py-3 text-base",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = "primary", size = "md", loading, disabled, className = "", children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_STYLES[variant]} ${SIZE_STYLES[size]} ${className}`}
        {...rest}
      >
        {loading && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
