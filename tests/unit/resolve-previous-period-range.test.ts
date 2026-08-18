import { describe, it, expect } from "vitest";
import { resolveDateRange, resolvePreviousPeriodRange } from "../../packages/domain/reporting/date-range";

const TZ = "Europe/Belgrade";

describe("resolvePreviousPeriodRange — calendar-correct previous comparable period (Faza 7, #1/#16)", () => {
  it("'today' -> exactly yesterday", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const current = resolveDateRange("today", TZ, { now });
    const previous = resolvePreviousPeriodRange("today", TZ, current);
    const expectedYesterday = resolveDateRange("yesterday", TZ, { now });
    expect(previous.from.toISOString()).toBe(expectedYesterday.from.toISOString());
    expect(previous.to.toISOString()).toBe(expectedYesterday.to.toISOString());
    // Nadovezuje se tačno na tekući period, bez preklapanja/rupe.
    expect(previous.to.getTime()).toBe(current.from.getTime());
  });

  it("'thisWeek' -> exactly the previous 7-day window (lastWeek)", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const current = resolveDateRange("thisWeek", TZ, { now });
    const previous = resolvePreviousPeriodRange("thisWeek", TZ, current);
    const expectedLastWeek = resolveDateRange("lastWeek", TZ, { now });
    expect(previous.from.toISOString()).toBe(expectedLastWeek.from.toISOString());
    expect(previous.to.toISOString()).toBe(expectedLastWeek.to.toISOString());
  });

  it("'thisMonth' -> the actual previous calendar month, even across different month lengths (31 -> 30)", () => {
    // Avgust ima 31 dan; generičko "pomeri unazad za istu širinu" bi dalo
    // pogrešan početak jula (koji ima TAKOĐE 31 dan, pa bi ovde slučajno
    // ispalo tačno — testirano je zato septembar (30 dana) unazad na avgust,
    // gde bi generički pomeraj dao pogrešan rezultat da nije prave
    // kalendarske aritmetike).
    const now = new Date("2026-09-15T10:00:00.000Z"); // septembar, 30 dana
    const current = resolveDateRange("thisMonth", TZ, { now });
    const previous = resolvePreviousPeriodRange("thisMonth", TZ, current);
    const expectedAugustStart = resolveDateRange("today", TZ, { now: new Date("2026-08-01T10:00:00.000Z") }).from;
    expect(previous.from.toISOString()).toBe(expectedAugustStart.toISOString());
    expect(previous.to.toISOString()).toBe(current.from.toISOString());
  });

  it("'thisYear' -> the actual previous calendar year", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    const current = resolveDateRange("thisYear", TZ, { now });
    const previous = resolvePreviousPeriodRange("thisYear", TZ, current);
    const expected2025Start = resolveDateRange("today", TZ, { now: new Date("2025-01-01T10:00:00.000Z") }).from;
    expect(previous.from.toISOString()).toBe(expected2025Start.toISOString());
    expect(previous.to.toISOString()).toBe(current.from.toISOString());
  });

  it("'custom' -> shifts back by the exact same width, contiguous with the current range", () => {
    const current = resolveDateRange("custom", TZ, { customFrom: "2026-08-01", customTo: "2026-08-10" }); // 10 dana
    const previous = resolvePreviousPeriodRange("custom", TZ, current);
    expect(previous.to.getTime()).toBe(current.from.getTime());
    expect(previous.to.getTime() - previous.from.getTime()).toBe(current.to.getTime() - current.from.getTime());
  });

  it("a multi-year custom range still resolves to a valid, equal-width previous range", () => {
    const current = resolveDateRange("custom", TZ, { customFrom: "2020-01-01", customTo: "2025-12-31" });
    const previous = resolvePreviousPeriodRange("custom", TZ, current);
    expect(previous.to.getTime()).toBe(current.from.getTime());
    expect(previous.to.getTime() - previous.from.getTime()).toBe(current.to.getTime() - current.from.getTime());
    expect(previous.from.getUTCFullYear()).toBeLessThan(2020);
  });
});
