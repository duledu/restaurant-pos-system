/**
 * PROMOTIONS & PRICING ENGINE V1 — pure, framework-free schedule evaluation.
 *
 * Lives in packages/shared (not packages/domain) SPECIFICALLY so the exact
 * same code runs on the server (authoritative resolveEffectivePrice, inside
 * packages/domain/promotions/promotion-service.ts) AND on the waiter client
 * (instant local preview of promo price/badge, apps/web) — a promotions
 * engine where the client's "preview" logic could ever disagree with the
 * server's "authority" logic would be worse than no preview at all. The
 * server remains the ONLY source of financial truth (see
 * resolveEffectivePrice) — this module is reused for UX speed, never
 * trusted as authorization.
 *
 * No large timezone library, matching the existing project decision in
 * packages/domain/reporting/date-range.ts (same "format then compare" trick
 * via Intl.DateTimeFormat, which is DST-safe because it asks Intl what time
 * it actually is in that zone, not a hand-computed fixed offset).
 */

export interface PromotionScheduleRule {
  /** JS Date.getDay() convention: 0=Sunday .. 6=Saturday. */
  daysOfWeek: number[];
  /** Minutes since midnight, 0-1439. */
  startTime: number;
  /** Minutes since midnight, 0-1439. <= startTime means the window crosses midnight. */
  endTime: number;
  /** "YYYY-MM-DD" or null — inclusive, restaurant-timezone calendar date. */
  startDate: string | null;
  /** "YYYY-MM-DD" or null — inclusive, restaurant-timezone calendar date. */
  endDate: string | null;
}

export interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  /** 0=Sunday .. 6=Saturday, matching PromotionScheduleRule.daysOfWeek. */
  weekday: number;
  minutesSinceMidnight: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** What time is it, right now, as seen from a wall clock in `timeZone`? */
export function zonedWallClock(at: Date, timeZone: string): ZonedWallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    minutesSinceMidnight: hour * 60 + Number(map.minute),
  };
}

interface YMD {
  year: number;
  month: number;
  day: number;
}

function ymdComparable(ymd: YMD): number {
  return ymd.year * 10000 + ymd.month * 100 + ymd.day;
}

function parseYMD(value: string): YMD {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Neispravan datum: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addDaysYMD(ymd: YMD, days: number): YMD {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * UTC instant corresponding to a specific wall-clock minute-of-day on a
 * given Y-M-D in `timeZone`. Same DST-safe "guess, reformat, correct"
 * technique as date-range.ts's zonedMidnightUtc, generalized to an
 * arbitrary minute of the day (not just midnight).
 */
function zonedInstant(ymd: YMD, minuteOfDay: number, timeZone: string): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const guess = Date.UTC(ymd.year, ymd.month - 1, ymd.day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const reinterpreted = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offset = reinterpreted - guess;
  return new Date(guess - offset);
}

/**
 * Is this schedule rule active at instant `at`, evaluated in `timeZone`?
 * Interval semantics: start INCLUSIVE, end EXCLUSIVE (17:00 <= t < 19:00) —
 * spec section 24's explicit choice. A cross-midnight window (endTime <=
 * startTime, e.g. 22:00-02:00) is active either "today from startTime
 * onward" (if today is a matched weekday) or "today before endTime" (if
 * YESTERDAY was a matched weekday and the window is still running).
 */
export function isScheduleActiveAt(rule: PromotionScheduleRule, at: Date, timeZone: string): boolean {
  if (rule.startTime === rule.endTime) return false; // zero-length window — never active, guards misconfiguration
  const wc = zonedWallClock(at, timeZone);
  const todayYMD: YMD = { year: wc.year, month: wc.month, day: wc.day };

  if (rule.startDate && ymdComparable(todayYMD) < ymdComparable(parseYMD(rule.startDate))) return false;
  if (rule.endDate && ymdComparable(todayYMD) > ymdComparable(parseYMD(rule.endDate))) return false;

  const crossesMidnight = rule.endTime <= rule.startTime;
  if (!crossesMidnight) {
    if (!rule.daysOfWeek.includes(wc.weekday)) return false;
    return wc.minutesSinceMidnight >= rule.startTime && wc.minutesSinceMidnight < rule.endTime;
  }

  const yesterdayWeekday = (wc.weekday + 6) % 7;
  const todayStartedIt = rule.daysOfWeek.includes(wc.weekday) && wc.minutesSinceMidnight >= rule.startTime;
  const yesterdayStartedIt = rule.daysOfWeek.includes(yesterdayWeekday) && wc.minutesSinceMidnight < rule.endTime;
  return todayStartedIt || yesterdayStartedIt;
}

/**
 * When does this rule's activeness next possibly flip, strictly after
 * `at`? Used to schedule exactly ONE client-side timeout (spec section 10
 * — "no aggressive polling", schedule expiry is deterministic) instead of
 * polling. Considers: the next start-time occurrence, the next end-time
 * occurrence (shifted a day for cross-midnight rules), and the rule's own
 * startDate/endDate boundaries. Returns null if the rule can never change
 * state again (e.g. daysOfWeek is empty, or endDate is already past).
 */
export function nextScheduleBoundary(rule: PromotionScheduleRule, at: Date, timeZone: string): Date | null {
  if (rule.daysOfWeek.length === 0 || rule.startTime === rule.endTime) return null;
  const wc = zonedWallClock(at, timeZone);
  const todayYMD: YMD = { year: wc.year, month: wc.month, day: wc.day };
  if (rule.endDate && ymdComparable(todayYMD) > ymdComparable(parseYMD(rule.endDate))) return null;
  const crossesMidnight = rule.endTime <= rule.startTime;
  const candidates: Date[] = [];

  function nextOccurrence(minuteOfDay: number, dayShift: number): Date | null {
    if (rule.daysOfWeek.length === 0) return null;
    // Include yesterday's start day when finding an overnight end today.
    for (let dayOffset = -dayShift; dayOffset <= 7; dayOffset++) {
      const matchWeekday = (wc.weekday + dayOffset + 7) % 7;
      if (!rule.daysOfWeek.includes(matchWeekday)) continue;
      const targetYMD = addDaysYMD(todayYMD, dayOffset + dayShift);
      const instant = zonedInstant(targetYMD, minuteOfDay, timeZone);
      if (instant.getTime() > at.getTime()) return instant;
    }
    return null;
  }

  const startCandidate = nextOccurrence(rule.startTime, 0);
  if (startCandidate) candidates.push(startCandidate);
  const endCandidate = nextOccurrence(rule.endTime, crossesMidnight ? 1 : 0);
  if (endCandidate) candidates.push(endCandidate);

  if (rule.startDate) {
    const instant = zonedInstant(parseYMD(rule.startDate), 0, timeZone);
    if (instant.getTime() > at.getTime()) candidates.push(instant);
  }
  if (rule.endDate) {
    // exclusive boundary — the day AFTER endDate is when it stops applying.
    const instant = zonedInstant(addDaysYMD(parseYMD(rule.endDate), 1), 0, timeZone);
    if (instant.getTime() > at.getTime()) candidates.push(instant);
  }

  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

export interface PromotionCandidate {
  id: string;
  name: string;
  type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE";
  value: number | string;
  priority: number;
  createdAt: string | Date;
  targetType: "MENU_ITEM" | "MENU_CATEGORY";
  schedule: PromotionScheduleRule;
}

/**
 * V1 NO-STACKING RULE (spec section 12): exactly one promotion may apply to
 * one OrderItem pricing event. Precedence, in order:
 *   1. An explicit MENU_ITEM target always beats a MENU_CATEGORY target.
 *   2. Within the same target level, higher `priority` wins.
 *   3. Deterministic tie-break: earliest `createdAt`, then lowest `id`
 *      (string compare) — never "whichever the DB happened to return first".
 * Only candidates that are ALREADY schedule-active at `at` are considered;
 * callers must pre-filter to promotions actually targeting this item.
 */
export function pickWinningPromotion(candidates: PromotionCandidate[], at: Date, timeZone: string): PromotionCandidate | null {
  const active = candidates.filter((c) => isScheduleActiveAt(c.schedule, at, timeZone));
  if (active.length === 0) return null;

  const itemLevel = active.filter((c) => c.targetType === "MENU_ITEM");
  const pool = itemLevel.length > 0 ? itemLevel : active;

  return pool.reduce((winner, candidate) => {
    if (!winner) return candidate;
    if (candidate.priority !== winner.priority) return candidate.priority > winner.priority ? candidate : winner;
    const candidateCreated = new Date(candidate.createdAt).getTime();
    const winnerCreated = new Date(winner.createdAt).getTime();
    if (candidateCreated !== winnerCreated) return candidateCreated < winnerCreated ? candidate : winner;
    return candidate.id < winner.id ? candidate : winner;
  }, null as PromotionCandidate | null);
}
