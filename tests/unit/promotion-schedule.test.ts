import { describe, expect, it } from "vitest";
import {
  isScheduleActiveAt,
  nextScheduleBoundary,
  pickWinningPromotion,
  zonedWallClock,
  zonedDateTimeToInstant,
  addDaysToDateString,
  type PromotionCandidate,
  type PromotionScheduleRule,
} from "../../packages/shared/promotion-schedule";

const TZ = "Europe/Belgrade";

function happyHour(overrides: Partial<PromotionScheduleRule> = {}): PromotionScheduleRule {
  return {
    daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
    startTime: 17 * 60,
    endTime: 19 * 60,
    startDate: null,
    endDate: null,
    ...overrides,
  };
}

// A Monday in Belgrade winter time (UTC+1, no DST) — 2026-01-05 is a Monday.
function belgradeInstant(hour: number, minute = 0, day = 5): Date {
  return new Date(Date.UTC(2026, 0, day, hour - 1, minute)); // UTC+1 in January
}

describe("zonedWallClock", () => {
  it("uses the supplied restaurant zone, including its DST offset, rather than the host zone", () => {
    expect(isScheduleActiveAt(happyHour(), new Date("2026-07-06T15:00:00Z"), TZ)).toBe(true); // 17:00 summer
    expect(isScheduleActiveAt(happyHour(), new Date("2026-07-06T17:00:00Z"), TZ)).toBe(false); // 19:00 summer
    expect(isScheduleActiveAt(happyHour(), new Date("2026-07-06T15:00:00Z"), "America/New_York")).toBe(false);
  });

  it("reads the correct weekday/hour/minute in the restaurant's timezone", () => {
    const wc = zonedWallClock(belgradeInstant(17, 30), TZ);
    expect(wc.weekday).toBe(1); // Monday
    expect(wc.minutesSinceMidnight).toBe(17 * 60 + 30);
  });
});

describe("isScheduleActiveAt — standard Happy Hour (17:00-19:00, Mon-Fri)", () => {
  it("is active in the middle of the window", () => {
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(18, 0), TZ)).toBe(true);
  });

  it("exact start is INCLUSIVE (17:00:00 is already active)", () => {
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(17, 0), TZ)).toBe(true);
  });

  it("one minute before start is NOT active", () => {
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(16, 59), TZ)).toBe(false);
  });

  it("exact end is EXCLUSIVE (19:00:00 is already inactive)", () => {
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(19, 0), TZ)).toBe(false);
  });

  it("one minute before end is still active", () => {
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(18, 59), TZ)).toBe(true);
  });

  it("is inactive on a non-matching day (Saturday)", () => {
    // 2026-01-10 is a Saturday.
    expect(isScheduleActiveAt(happyHour(), belgradeInstant(18, 0, 10), TZ)).toBe(false);
  });

  it("multiple weekdays: active on every configured day, inactive on others", () => {
    const rule = happyHour({ daysOfWeek: [1, 3, 5] }); // Mon/Wed/Fri
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 5), TZ)).toBe(true); // Mon
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 6), TZ)).toBe(false); // Tue
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 7), TZ)).toBe(true); // Wed
  });

  it("a zero-length window (start === end) is never active — guards misconfiguration", () => {
    const rule = happyHour({ startTime: 600, endTime: 600 });
    expect(isScheduleActiveAt(rule, belgradeInstant(10, 0), TZ)).toBe(false);
  });
});

describe("isScheduleActiveAt — cross-midnight (22:00-02:00)", () => {
  const rule = happyHour({ daysOfWeek: [5], startTime: 22 * 60, endTime: 2 * 60 }); // Friday only

  it("active right after start, same calendar day (Friday 23:00)", () => {
    // 2026-01-09 is a Friday.
    expect(isScheduleActiveAt(rule, belgradeInstant(23, 0, 9), TZ)).toBe(true);
  });

  it("active after midnight, on the FOLLOWING calendar day (Saturday 01:00)", () => {
    expect(isScheduleActiveAt(rule, belgradeInstant(1, 0, 10), TZ)).toBe(true);
  });

  it("exact cross-midnight end is exclusive (Saturday 02:00)", () => {
    expect(isScheduleActiveAt(rule, belgradeInstant(2, 0, 10), TZ)).toBe(false);
  });

  it("inactive before start on Friday (Friday 21:59)", () => {
    expect(isScheduleActiveAt(rule, belgradeInstant(21, 59, 9), TZ)).toBe(false);
  });

  it("inactive on Saturday daytime — the window only ever belongs to the Friday occurrence", () => {
    expect(isScheduleActiveAt(rule, belgradeInstant(15, 0, 10), TZ)).toBe(false);
  });

  it("day transition: Saturday 01:00 is active, but Sunday 01:00 is not (Saturday isn't a configured day)", () => {
    expect(isScheduleActiveAt(rule, belgradeInstant(1, 0, 10), TZ)).toBe(true); // early Saturday, from Friday's window
    expect(isScheduleActiveAt(rule, belgradeInstant(1, 0, 11), TZ)).toBe(false); // early Sunday, from a (non-configured) Saturday start
  });
});

describe("isScheduleActiveAt — date range", () => {
  it("inactive before startDate", () => {
    const rule = happyHour({ startDate: "2026-02-01" });
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 5), TZ)).toBe(false); // Jan 5
  });

  it("active on/after startDate", () => {
    const rule = happyHour({ startDate: "2026-01-05" });
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 5), TZ)).toBe(true);
  });

  it("inactive after endDate (endDate is inclusive, the day after is not)", () => {
    const rule = happyHour({ endDate: "2026-01-05" });
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 5), TZ)).toBe(true); // on endDate
    expect(isScheduleActiveAt(rule, belgradeInstant(18, 0, 6), TZ)).toBe(false); // day after (also would need Tuesday to match daysOfWeek, but blocked by date first)
  });

  it("a future promotion is not yet active, an expired one no longer is", () => {
    const future = happyHour({ startDate: "2099-01-01" });
    const expired = happyHour({ endDate: "2020-01-01" });
    expect(isScheduleActiveAt(future, belgradeInstant(18, 0), TZ)).toBe(false);
    expect(isScheduleActiveAt(expired, belgradeInstant(18, 0), TZ)).toBe(false);
  });
});

describe("isScheduleActiveAt — inactive promotion is a caller concern", () => {
  it("(documented) this function only evaluates the SCHEDULE — Promotion.isActive is filtered by the caller before candidates ever reach here", () => {
    // No isActive field exists on PromotionScheduleRule by design — the
    // resolver (promotion-service.ts) filters `isActive: true` at the
    // database query level before building candidates at all.
    expect(Object.keys(happyHour())).not.toContain("isActive");
  });
});

function candidate(overrides: Partial<PromotionCandidate>): PromotionCandidate {
  return {
    id: "a",
    name: "Test",
    type: "PERCENTAGE_DISCOUNT",
    value: 20,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    targetType: "MENU_ITEM",
    schedule: happyHour(),
    ...overrides,
  };
}

describe("pickWinningPromotion — no stacking, deterministic precedence", () => {
  const at = belgradeInstant(18, 0);

  it("returns null when there are no candidates", () => {
    expect(pickWinningPromotion([], at, TZ)).toBeNull();
  });

  it("returns null when the only candidate is not schedule-active", () => {
    const inactiveNow = candidate({ schedule: happyHour({ daysOfWeek: [6] }) }); // Saturday only, but `at` is Monday
    expect(pickWinningPromotion([inactiveNow], at, TZ)).toBeNull();
  });

  it("explicit MENU_ITEM target always beats MENU_CATEGORY, regardless of priority", () => {
    const itemLevel = candidate({ id: "item-promo", targetType: "MENU_ITEM", priority: 0 });
    const categoryLevel = candidate({ id: "category-promo", targetType: "MENU_CATEGORY", priority: 100 });
    const winner = pickWinningPromotion([categoryLevel, itemLevel], at, TZ);
    expect(winner?.id).toBe("item-promo");
  });

  it("within the same target level, higher priority wins", () => {
    const low = candidate({ id: "low", targetType: "MENU_CATEGORY", priority: 1 });
    const high = candidate({ id: "high", targetType: "MENU_CATEGORY", priority: 5 });
    expect(pickWinningPromotion([low, high], at, TZ)?.id).toBe("high");
  });

  it("tie-break: same priority, earliest createdAt wins", () => {
    const later = candidate({ id: "later", createdAt: "2026-01-02T00:00:00.000Z" });
    const earlier = candidate({ id: "earlier", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(pickWinningPromotion([later, earlier], at, TZ)?.id).toBe("earlier");
  });

  it("tie-break: same priority AND createdAt, lowest id wins (fully deterministic, never DB-order-dependent)", () => {
    const b = candidate({ id: "b" });
    const a = candidate({ id: "a" });
    expect(pickWinningPromotion([b, a], at, TZ)?.id).toBe("a");
  });

  it("never stacks: exactly one winner even when multiple item-level candidates are simultaneously active", () => {
    const first = candidate({ id: "first", priority: 5 });
    const second = candidate({ id: "second", priority: 3 });
    const winner = pickWinningPromotion([first, second], at, TZ);
    expect(winner?.id).toBe("first");
    // Only one promotion is ever returned — never a combined/summed discount.
    expect(Array.isArray(winner)).toBe(false);
  });

  it("category + item precedence: an active category promo is ignored when an active item promo also exists (spec section 12)", () => {
    const category = candidate({ id: "cat", targetType: "MENU_CATEGORY" });
    const item = candidate({ id: "item", targetType: "MENU_ITEM" });
    expect(pickWinningPromotion([category, item], at, TZ)?.id).toBe("item");
  });
});

describe("nextScheduleBoundary — deterministic scheduling for client-side refresh (no polling)", () => {
  it("expires Friday's overnight window when the screen opens after midnight on Saturday", () => {
    const rule = happyHour({ daysOfWeek: [5], startTime: 22 * 60, endTime: 2 * 60 });
    expect(nextScheduleBoundary(rule, belgradeInstant(1, 0, 10), TZ)).toEqual(belgradeInstant(2, 0, 10));
  });

  it("does not keep scheduling timers after the date range has ended", () => {
    expect(nextScheduleBoundary(happyHour({ endDate: "2026-01-05" }), belgradeInstant(10, 0, 6), TZ)).toBeNull();
  });

  it("from before the window, the next boundary is today's start", () => {
    const rule = happyHour();
    const next = nextScheduleBoundary(rule, belgradeInstant(10, 0), TZ);
    expect(next).not.toBeNull();
    expect(isScheduleActiveAt(rule, next!, TZ)).toBe(true); // instant of the boundary is already inside the window (start inclusive)
  });

  it("from inside the window, the next boundary is today's end", () => {
    const rule = happyHour();
    const at = belgradeInstant(18, 0);
    const next = nextScheduleBoundary(rule, at, TZ)!;
    const justBefore = new Date(next.getTime() - 1000);
    expect(isScheduleActiveAt(rule, justBefore, TZ)).toBe(true);
    expect(isScheduleActiveAt(rule, next, TZ)).toBe(false);
  });

  it("cross-midnight: the next boundary from inside the window is correctly the NEXT day's end time", () => {
    const rule = happyHour({ daysOfWeek: [5], startTime: 22 * 60, endTime: 2 * 60 });
    const at = belgradeInstant(23, 0, 9); // Friday 23:00
    const next = nextScheduleBoundary(rule, at, TZ)!;
    expect(next).not.toBeNull();
    const wc = zonedWallClock(next, TZ);
    expect(wc.weekday).toBe(6); // Saturday
    expect(wc.minutesSinceMidnight).toBe(2 * 60);
  });

  it("respects an endDate boundary (the day after endDate, at midnight)", () => {
    const rule = happyHour({ endDate: "2026-01-05" });
    const at = belgradeInstant(18, 0, 5); // inside the window, on endDate itself
    const next = nextScheduleBoundary(rule, at, TZ)!;
    expect(next).not.toBeNull();
    // Whatever boundary comes first (today's end-time or the date cutoff) —
    // the rule must be inactive at/after it once the date range is exhausted.
    const dayAfterEndDate = belgradeInstant(0, 1, 6);
    expect(next.getTime()).toBeLessThanOrEqual(dayAfterEndDate.getTime());
  });

  it("returns null when the rule has no configured days at all (can never change state)", () => {
    const rule = happyHour({ daysOfWeek: [] });
    expect(nextScheduleBoundary(rule, belgradeInstant(10, 0), TZ)).toBeNull();
  });
});

describe("zonedDateTimeToInstant — reused by Reservations V1 for reservedAt", () => {
  it("turns a local date+time in the restaurant timezone into the correct UTC instant", () => {
    const instant = zonedDateTimeToInstant("2026-01-05", 19 * 60 + 30, TZ); // 19:30 Belgrade, January (UTC+1)
    expect(instant.getTime()).toBe(belgradeInstant(19, 30, 5).getTime());
  });

  it("round-trips through zonedWallClock", () => {
    const instant = zonedDateTimeToInstant("2026-06-15", 12 * 60, TZ);
    const wc = zonedWallClock(instant, TZ);
    expect(wc).toMatchObject({ year: 2026, month: 6, day: 15, minutesSinceMidnight: 12 * 60 });
  });
});

describe("addDaysToDateString — Reservations V1 date navigation (Juče/Danas/Sutra)", () => {
  it("adds and subtracts days across a calendar date", () => {
    expect(addDaysToDateString("2026-01-05", 1)).toBe("2026-01-06");
    expect(addDaysToDateString("2026-01-05", -1)).toBe("2026-01-04");
  });

  it("rolls over month and year boundaries correctly", () => {
    expect(addDaysToDateString("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToDateString("2025-12-31", 1)).toBe("2026-01-01");
  });
});
