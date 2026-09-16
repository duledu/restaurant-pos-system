"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalPrintRole = "KITCHEN" | "BAR" | "RECEIPT";
// "checking" is the true initial state, before the very first status check
// resolves — treated the same as "not-applicable" (hidden) by
// TerminalBindingBadge, so a CENTRAL_ROUTING login never shows even a brief
// flash of "Poveži ovaj računar" while that first request is in flight.
export type TerminalBindingStatus = "checking" | "idle" | "not-applicable" | "connecting" | "bound" | "error";
export interface TerminalBindingState {
  status: TerminalBindingStatus;
  printRole: TerminalPrintRole | null;
  error: string | null;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

// Well under the server's rolling TTL (terminal-service.ts
// TERMINAL_HEARTBEAT_INTERVAL_MS/TTL) — a closed/crashed tab simply stops
// calling this, so the binding lapses on its own.
const HEARTBEAT_MS = 30_000;
const STATUS_POLL_MS = 1_500;
// ~60s window for the OS to resolve tablecore-print:// and the launched
// Agent process to complete its own HTTP round trip to the server.
const STATUS_POLL_ATTEMPTS = 40;

/**
 * PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side. Mounted
 * once per waiter/KDS shell (see waiter-shell.tsx PreparedShell /
 * KdsClient.tsx). Fully inert for any role with no operational print
 * mapping and for restaurants in CENTRAL_ROUTING mode — the server decides
 * this (terminal.operationalPrintRoleFor / createTerminalBindIntent
 * returning null), never guessed here.
 *
 * `bind()` is ONLY ever called from a real click handler, never
 * automatically on mount: browsers require an actual user gesture to
 * navigate a custom URI scheme (tablecore-print://) at all — an
 * auto-fired attempt would silently do nothing in most browsers, so a
 * one-click "Poveži ovaj računar" action is not just a UX choice, it is a
 * technical requirement of how custom protocol handlers work.
 */
export function useTerminalBinding() {
  const [state, setState] = useState<TerminalBindingState>({ status: "checking", printRole: null, error: null });
  const alive = useRef(true);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const refreshStatus = useCallback(async (): Promise<TerminalPrintRole | null> => {
    try {
      const res = await apiFetch("/api/pos/terminal/status");
      if (!alive.current) return null;
      // REGRESSION FIX — "Poveži ovaj računar" was showing on every login
      // for logins where binding is not even a relevant concept (a
      // CENTRAL_ROUTING restaurant, or a role with no operational print
      // mapping): the OLD code only ever learned "not-applicable" reactively,
      // AFTER an actual (fruitless) bind click — every fresh mount defaulted
      // back to "idle" (visible) in the meantime, and a fresh mount happens
      // on every login. The server now reports applicability up front, from
      // this very first status check.
      if (!res.applicable) {
        setState({ status: "not-applicable", printRole: null, error: null });
        return null;
      }
      if (res.status) {
        setState({ status: "bound", printRole: res.status.printRole, error: null });
        return res.status.printRole as TerminalPrintRole;
      }
      setState((prev) => (prev.status === "idle" ? prev : { status: "idle", printRole: null, error: null }));
      return null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    return () => {
      alive.current = false;
    };
  }, [refreshStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (statusRef.current === "bound") void apiFetch("/api/pos/terminal/heartbeat", { method: "POST" }).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, []);

  const bind = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "connecting", error: null }));
    try {
      const res = await apiFetch("/api/pos/terminal/bind-intent", { method: "POST" });
      if (!res.intent) {
        setState({ status: "not-applicable", printRole: null, error: null });
        return;
      }
      // Same technique as the already-shipped Admin -> Agent pairing
      // handoff (WorkstationsPanel.tsx openPrintAgent): the browser
      // intercepts this navigation and either opens the paired Agent
      // (installer-registered protocol handler, ONLY present on that exact
      // machine) or does nothing at all — never actually navigates away.
      window.location.href = `tablecore-print://bind?token=${encodeURIComponent(res.intent.token)}`;
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
        if (!alive.current) return;
        const printRole = await refreshStatus();
        if (printRole) return;
      }
      setState({
        status: "error",
        printRole: null,
        error: "Povezivanje nije potvrđeno. Proverite da li je TableCore Print Agent instaliran na ovom računaru i pokušajte ponovo.",
      });
    } catch (e) {
      setState({ status: "error", printRole: null, error: e instanceof Error ? e.message : "Greška pri povezivanju" });
    }
  }, [refreshStatus]);

  return { ...state, bind, refreshStatus };
}
