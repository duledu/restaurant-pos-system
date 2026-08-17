import { describe, it, expect } from "vitest";
import { resolveDateRange } from "../../packages/domain/reporting/date-range";

describe("resolveDateRange — timezone-safe boundaries (Faza 5, #25)", () => {
  it("computes 'today' using the RESTAURANT's local midnight, not UTC midnight (Belgrade, CEST +2 in August)", () => {
    // 2026-08-17T10:00:00Z je 12:00 lokalno u Beogradu (CEST, UTC+2 u avgustu).
    const now = new Date("2026-08-17T10:00:00.000Z");
    const range = resolveDateRange("today", "Europe/Belgrade", { now });
    expect(range.from.toISOString()).toBe("2026-08-16T22:00:00.000Z"); // 00:00 lokalno 17.08 = 22:00 UTC 16.08
    expect(range.to.toISOString()).toBe("2026-08-17T22:00:00.000Z"); // 00:00 lokalno 18.08
  });

  it("counts a late-night local transaction on the correct calendar day", () => {
    // 23:40 lokalno u Beogradu 17.08 (CEST +2) = 21:40 UTC 17.08 — mora upasti
    // u opseg za 17.08, ne 18.08 (ovo je tačno scenario zbog kog UTC-only
    // računanje pravi grešku).
    const lateNightPayment = new Date("2026-08-17T21:40:00.000Z");
    const range = resolveDateRange("today", "Europe/Belgrade", { now: lateNightPayment });
    expect(lateNightPayment >= range.from && lateNightPayment < range.to).toBe(true);
  });

  it("computes 'yesterday' as the full previous local calendar day", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const range = resolveDateRange("yesterday", "Europe/Belgrade", { now });
    expect(range.from.toISOString()).toBe("2026-08-15T22:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-08-16T22:00:00.000Z");
  });

  it("computes 'last7days' as a 7-day inclusive window ending today", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const range = resolveDateRange("last7days", "Europe/Belgrade", { now });
    expect(range.from.toISOString()).toBe("2026-08-10T22:00:00.000Z"); // 00:00 lokalno 11.08
    expect(range.to.toISOString()).toBe("2026-08-17T22:00:00.000Z");
  });

  it("computes 'last30days' as a 30-day inclusive window ending today", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const range = resolveDateRange("last30days", "Europe/Belgrade", { now });
    const days = (range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(30);
  });

  it("handles a custom inclusive date range, converting the 'to' date to an exclusive next-day boundary", () => {
    const range = resolveDateRange("custom", "Europe/Belgrade", { customFrom: "2026-08-01", customTo: "2026-08-10" });
    expect(range.from.toISOString()).toBe("2026-07-31T22:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-08-10T22:00:00.000Z"); // isključivo — počinje SLEDEĆI dan posle 10.08
  });

  it("rejects a custom range where 'from' is after 'to'", () => {
    expect(() => resolveDateRange("custom", "Europe/Belgrade", { customFrom: "2026-08-10", customTo: "2026-08-01" })).toThrow();
  });

  it("rejects a custom range missing from/to", () => {
    expect(() => resolveDateRange("custom", "Europe/Belgrade", {})).toThrow();
  });

  it("respects a different restaurant timezone (not hardcoded to Belgrade)", () => {
    // New York u avgustu je EDT (UTC-4). Ponoć lokalno 17.08 = 04:00 UTC 17.08.
    const now = new Date("2026-08-17T10:00:00.000Z");
    const range = resolveDateRange("today", "America/New_York", { now });
    expect(range.from.toISOString()).toBe("2026-08-17T04:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-08-18T04:00:00.000Z");
  });
});
