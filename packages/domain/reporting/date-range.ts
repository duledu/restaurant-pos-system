/**
 * Vremenske granice za izveštaje — Faza 5, tačka #25 specifikacije.
 *
 * ODLUKA (dokumentovano po zahtevu): "Danas"/"Juče"/... se računaju u
 * VREMENSKOJ ZONI RESTORANA (Restaurant.timezone, već postoji u šemi od
 * Faze 1 — @default("Europe/Belgrade")), ne u UTC i ne u vremenskoj zoni
 * servera. Bez ovoga bi kasna večernja transakcija (npr. 23:40 lokalno)
 * mogla da upadne u "sutrašnji" dan po UTC-u, ili obrnuto.
 *
 * NAMERNO nema poseban "poslovni dan" (npr. 06:00-06:00) koncept — to bi
 * zahtevalo dodatnu konfiguraciju po restoranu koju Faza 1-4 ne uvodi.
 * Kalendarski dan u lokalnoj zoni je najjednostavnije ispravno pravilo za
 * MVP; ako se pokaže potreba za "poslovnim danom" (smena preko ponoći koja
 * treba da se računa kao "juče"), to je eksplicitna, izolovana izmena ove
 * jedne funkcije, ne šire arhitekture.
 *
 * IZVOR ISTINE ZA FINANSIJSKE UPITE: Payment.completedAt (kada je novac
 * STVARNO primljen), NIKAD Order.createdAt (kada je porudžbina OTVORENA).
 * Sto koje je otvoreno u 23:50 a plaćeno u 00:10 spada u dan kad je
 * PLAĆENO — vidi tačku #26 specifikacije ("Prefer Payment/Receipt").
 *
 * Bez spoljnih biblioteka (namerno, zahtev "no large timezone framework")
 * — koristi se standardni "dupli format" trik preko Intl.DateTimeFormat,
 * koji ispravno hvata DST pomeraje jer pита sam Intl šta je "sada" u toj
 * zoni, ne računa fiksni offset ručno.
 */

export const REPORT_PRESETS = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "thisYear",
  "last7days",
  "last30days",
  "custom",
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export interface DateRange {
  /** Uključivo (>=) */
  from: Date;
  /** Isključivo (<) */
  to: Date;
}

interface ZonedYMD {
  year: number;
  month: number;
  day: number;
}

function zonedYMD(date: Date, timeZone: string): ZonedYMD {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    date
  );
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/**
 * UTC trenutak koji odgovara lokalnoj ponoći (00:00:00) datog Y-M-D u
 * `timeZone`. Standardni "formatiraj pa uporedi" trik — ispravan preko DST
 * granica jer se offset izvodi iz stvarnog Intl odgovora za taj konkretan
 * datum, ne iz fiksne konstante.
 */
function zonedMidnightUtc({ year, month, day }: ZonedYMD, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
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

function addDaysYMD(ymd: ZonedYMD, days: number): ZonedYMD {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ── FAZA 6: thisWeek/lastWeek/thisMonth/lastMonth/thisYear — weekday i
// mesec/godina aritmetika rade nad "plain" Y-M-D trojkom (nezavisno od
// vremenske zone, kalendarski datum je kalendarski datum), samo krajnja
// granica prolazi kroz zonedMidnightUtc kao i kod postojećih preseta.
// Nedelja počinje PONEDELJKOM (ISO 8601, standard u Srbiji).

function startOfWeekYMD(ymd: ZonedYMD): ZonedYMD {
  const weekday = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay(); // 0=Ned..6=Sub
  const isoWeekday = weekday === 0 ? 7 : weekday; // 1=Pon..7=Ned
  return addDaysYMD(ymd, -(isoWeekday - 1));
}

function firstOfMonthYMD(ymd: ZonedYMD): ZonedYMD {
  return { year: ymd.year, month: ymd.month, day: 1 };
}

function addMonthsToFirstOfMonth(ymd: ZonedYMD, months: number): ZonedYMD {
  const total = ymd.year * 12 + (ymd.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, day: 1 };
}

function parseYMD(value: string): ZonedYMD {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Neispravan datum: ${value} (očekivan format GGGG-MM-DD)`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function resolveDateRange(
  preset: ReportPreset,
  timeZone: string,
  options: { now?: Date; customFrom?: string; customTo?: string } = {}
): DateRange {
  const now = options.now ?? new Date();
  const todayYMD = zonedYMD(now, timeZone);

  if (preset === "today") {
    return { from: zonedMidnightUtc(todayYMD, timeZone), to: zonedMidnightUtc(addDaysYMD(todayYMD, 1), timeZone) };
  }
  if (preset === "yesterday") {
    const yesterday = addDaysYMD(todayYMD, -1);
    return { from: zonedMidnightUtc(yesterday, timeZone), to: zonedMidnightUtc(todayYMD, timeZone) };
  }
  if (preset === "last7days") {
    return {
      from: zonedMidnightUtc(addDaysYMD(todayYMD, -6), timeZone),
      to: zonedMidnightUtc(addDaysYMD(todayYMD, 1), timeZone),
    };
  }
  if (preset === "last30days") {
    return {
      from: zonedMidnightUtc(addDaysYMD(todayYMD, -29), timeZone),
      to: zonedMidnightUtc(addDaysYMD(todayYMD, 1), timeZone),
    };
  }
  if (preset === "thisWeek") {
    const start = startOfWeekYMD(todayYMD);
    return { from: zonedMidnightUtc(start, timeZone), to: zonedMidnightUtc(addDaysYMD(start, 7), timeZone) };
  }
  if (preset === "lastWeek") {
    const start = addDaysYMD(startOfWeekYMD(todayYMD), -7);
    return { from: zonedMidnightUtc(start, timeZone), to: zonedMidnightUtc(addDaysYMD(start, 7), timeZone) };
  }
  if (preset === "thisMonth") {
    const start = firstOfMonthYMD(todayYMD);
    return { from: zonedMidnightUtc(start, timeZone), to: zonedMidnightUtc(addMonthsToFirstOfMonth(start, 1), timeZone) };
  }
  if (preset === "lastMonth") {
    const thisMonthStart = firstOfMonthYMD(todayYMD);
    const start = addMonthsToFirstOfMonth(thisMonthStart, -1);
    return { from: zonedMidnightUtc(start, timeZone), to: zonedMidnightUtc(thisMonthStart, timeZone) };
  }
  if (preset === "thisYear") {
    const start: ZonedYMD = { year: todayYMD.year, month: 1, day: 1 };
    return { from: zonedMidnightUtc(start, timeZone), to: zonedMidnightUtc({ year: start.year + 1, month: 1, day: 1 }, timeZone) };
  }

  // custom
  if (!options.customFrom || !options.customTo) {
    throw new Error("Prilagođeni period zahteva 'from' i 'to' datume");
  }
  const from = zonedMidnightUtc(parseYMD(options.customFrom), timeZone);
  // "to" je INKLUZIVAN datum sa korisničke strane ("od 1. do 10.avgusta"
  // uključuje ceo 10.) — pretvara se u ekskluzivnu granicu sledećeg dana.
  const to = zonedMidnightUtc(addDaysYMD(parseYMD(options.customTo), 1), timeZone);
  if (from >= to) throw new Error("Period 'od' mora biti pre perioda 'do'");
  return { from, to };
}
