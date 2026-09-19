import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FIX #11 — RECEIPT-ACTION UX (post-payment screen).
 *
 * Product behavior: after a successful payment, the RECEIPT PrintJob is
 * dispatched AUTOMATICALLY (see billing-service.ts:completePayment →
 * dispatchReceiptPrintJob with dispatchKey "receipt:<paymentId>") and the
 * paired Windows Print Agent picks it up on its own poll loop. The
 * waiter-side bill screen therefore exposes ONE manual print action only:
 * "Ponovi štampu računa". A second redundant "Štampaj račun" button would
 * confuse the operator (two controls with overlapping intent) and must
 * therefore NOT appear in the UI source.
 *
 * This file pins that contract at the source level (same anti-footgun
 * pattern used by fix-1-admin-test-print.test.ts case K for the legacy
 * "Probna štampa" browser-print button on the Admin Printers Settings
 * page). The runtime behavior — idempotent server-side upsert, Agent
 * claimability of reprints, no SUBMISSION_UNKNOWN auto-reprint — is
 * already covered by print-reprint.test.ts and print-hardening.test.ts,
 * which this test deliberately does not duplicate.
 */

describe("FIX #11 — post-payment receipt UX exposes ONE intentional reprint control only", () => {
  const BILL_CLIENT_PATH = resolve(
    __dirname,
    "..",
    "..",
    "apps",
    "web",
    "app",
    "waiter",
    "tables",
    "[tableId]",
    "bill",
    "bill-client.tsx",
  );

  it("bill-client.tsx source contains the intentional reprint control", () => {
    expect(existsSync(BILL_CLIENT_PATH)).toBe(true);
    const source = readFileSync(BILL_CLIENT_PATH, "utf8");

    // The button label the restaurant-facing operator will see and tap.
    // Polish: full-width, single-row card; py-3.5 to satisfy the ≥44px
    // touch target; visible in-flight wording consistent with TableCore.
    expect(source).toMatch(/Ponovi štampu računa/);

    // The button text must INCLUDE the in-flight wording consistent with
    // the rest of TableCore's "Šaljem …" family. Required because the
    // button itself is the single source of truth for the in-flight
    // state (no redundant banner).
    expect(source).toMatch(/Šaljem na štampač/);
  });

  it("bill-client.tsx source does NOT contain the redundant automatic 'Štampaj račun' button", () => {
    const source = readFileSync(BILL_CLIENT_PATH, "utf8");

    // Anti-footgun: the button label "Štampaj račun" must not appear in
    // the post-payment screen. Payment itself dispatches the receipt via
    // completePayment → dispatchReceiptPrintJob; the only manual control
    // left is the explicit intentional reprint.
    expect(source).not.toMatch(/["']Štampaj račun["']/);
  });

  it("bill-client.tsx source does NOT keep the dead handlePrint handler or its client helper", () => {
    const source = readFileSync(BILL_CLIENT_PATH, "utf8");

    // Once the button is gone, both the handler AND its dependent client
    // helper import become dead code. Pin that they were removed together
    // so a future regression cannot leave an orphan import behind.
    expect(source).not.toMatch(/handlePrint\b/);
    // The client-side printReceipt helper in lib/print-client.ts is
    // unused inside this file post-fix. The server-side
    // `printing.printReceipt` and its endpoint remain reachable from any
    // future caller that needs the deterministic re-dispatch path; the
    // client-side import here was the only one.
    expect(source).not.toMatch(/import \{[^}]*\bprintReceipt\b/);
  });

  it("bill-client.tsx post-payment action area is a SINGLE button, not a grid", () => {
    const source = readFileSync(BILL_CLIENT_PATH, "utf8");

    // The post-payment receipt section must no longer render two side-by
    // side buttons. The `grid-cols-2` later in the file is for the
    // Gotovina/Kartica payment-method picker — that one is correct and
    // must stay; we anchor this assertion to the actual receipt BUTTON
    // element (anchored on its unique onClick handler, not on the label
    // which also appears in the source comment) and confirm the wrapper
    // containing it is NOT a grid.
    const btnIdx = source.indexOf('onClick={handleReprint}');
    expect(btnIdx, "bill-client.tsx must contain the handleReprint button").toBeGreaterThan(-1);

    // Walk backwards to find the immediate enclosing wrapper `<div …>`
    // that opens right before the button. That wrapper is the receipt
    // action area.
    const before = source.slice(0, btnIdx);
    const openIdx = before.lastIndexOf("<div");
    expect(openIdx, "expected an enclosing <div> wrapper around the receipt button").toBeGreaterThan(-1);

    const closeIdxAfter = source.indexOf("</div>", btnIdx);
    expect(closeIdxAfter, "expected a closing </div> after the receipt button").toBeGreaterThan(-1);

    const receiptBlock = source.slice(openIdx, closeIdxAfter + "</div>".length);
    expect(receiptBlock).not.toMatch(/grid-cols-2/);
    // Exactly ONE <button> inside — pins "single button" too.
    expect((receiptBlock.match(/<button\b/g) ?? []).length).toBe(1);
  });
});
