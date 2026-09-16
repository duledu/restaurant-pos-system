"use client";

import { useTerminalBinding } from "../../lib/terminal-binding";

const ROLE_LABEL: Record<string, string> = { KITCHEN: "KUHINJA", BAR: "ŠANK", RECEIPT: "RAČUN" };

/**
 * PRINTING V2 FINAL — LOGIN_AWARE terminal binding indicator/action.
 * Renders nothing at all (not even a placeholder) while the very first
 * status check is still in flight ("checking") or once the server has
 * confirmed this login has no operational print role / the restaurant is
 * in CENTRAL_ROUTING mode ("not-applicable") — see
 * useTerminalBinding/terminal-service.ts. "idle" (genuinely LOGIN_AWARE +
 * an operational role, just not yet bound this session) still shows the
 * "Poveži ovaj računar" action — hiding it there would make the button
 * impossible to ever click. Mount once per waiter/KDS shell (KdsClient.tsx,
 * waiter-shell.tsx).
 */
export function TerminalBindingBadge({ theme = "light" }: { theme?: "light" | "dark" }) {
  const { status, printRole, error, bind } = useTerminalBinding();
  if (status === "not-applicable" || status === "checking") return null;

  const textClass = theme === "dark" ? "text-cream-300/70" : "text-inkSoft";
  if (status === "bound") {
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${textClass}`} title="Ovaj računar prima poslove za ovu operativnu ulogu.">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        Radna stanica: {ROLE_LABEL[printRole ?? ""] ?? printRole}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={bind}
        disabled={status === "connecting"}
        className={`text-xs font-medium underline decoration-dotted underline-offset-2 disabled:opacity-50 ${textClass}`}
      >
        {status === "connecting" ? "Povezivanje…" : status === "error" ? "Poveži ovaj računar (pokušaj ponovo)" : "Poveži ovaj računar"}
      </button>
      {status === "error" && error && <span className="max-w-[220px] text-right text-[10px] text-danger">{error}</span>}
    </span>
  );
}
