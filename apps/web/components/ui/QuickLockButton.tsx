"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getAutoLockMs, isSharedPosMode } from "../../lib/shared-pos";

const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "wheel"] as const;

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/**
 * POST /api/auth/lock pa preusmeri na PIN ekran. Server briše sesiju
 * (isti mehanizam kao logout — vidi napomenu u api/auth/lock/route.ts);
 * ne postoji client-side stanje porudžbina/smena koje bi trebalo očistiti
 * jer ništa od toga nije vezano za sesiju.
 */
async function lockTerminal() {
  try {
    await fetch("/api/auth/lock", { method: "POST" });
  } finally {
    window.location.assign("/login");
  }
}

export function QuickLockButton({ theme = "light" }: { theme?: "light" | "dark" }) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVisible(isSharedPosMode());
  }, []);

  const resetAutoLockTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const ms = getAutoLockMs();
    if (!visible || ms <= 0) return;
    timerRef.current = setTimeout(() => {
      lockTerminal();
    }, ms);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    resetAutoLockTimer();
    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, resetAutoLockTimer, { passive: true });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, resetAutoLockTimer);
    };
  }, [visible, resetAutoLockTimer]);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={async () => {
        if (loading) return;
        setLoading(true);
        await lockTerminal();
      }}
      disabled={loading}
      className={`flex min-h-11 items-center gap-1.5 rounded-sm px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
        theme === "dark"
          ? "text-gold hover:bg-white/[0.06]"
          : "text-graphite hover:bg-ink/[0.05]"
      }`}
      aria-label={loading ? "Zaključavanje" : "Zaključaj terminal"}
    >
      <LockIcon />
      {loading ? "Zaključavanje…" : "Zaključaj"}
    </button>
  );
}
