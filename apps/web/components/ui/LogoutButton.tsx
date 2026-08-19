"use client";

import { useState } from "react";

export function LogoutButton({ theme = "light" }: { theme?: "light" | "dark" }) {
  const [loading, setLoading] = useState(false);

  async function logout() {
    if (loading) return;
    setLoading(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) window.location.assign("/login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={loading}
      className={`inline-flex min-h-11 items-center rounded-sm px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
        theme === "dark"
          ? "text-cream-300/70 hover:bg-white/[0.06] hover:text-white"
          : "text-inkSoft hover:bg-ink/[0.05] hover:text-ink"
      }`}
      aria-label={loading ? "Odjavljivanje" : "Odjavi se"}
    >
      {loading ? "Odjavljivanje…" : "Odjavi se"}
    </button>
  );
}
