/**
 * Date maths: "days until dec 25", "weeks since jan 1", "days between mar 1 and jun 30",
 * "today + 3 weeks", "christmas - 10 days", "90 days from now", "2 weeks ago", "in 45 minutes".
 * Calendar units (day/week/month/year) move the local calendar date; hours/minutes move the instant.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_MS = 86_400_000;

type CalUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

const UNIT_ALIASES: Record<string, CalUnit> = {
  m: "minute", min: "minute", mins: "minute", minute: "minute", minutes: "minute",
  h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", wk: "week", wks: "week", week: "week", weeks: "week",
  mo: "month", mos: "month", month: "month", months: "month",
  y: "year", yr: "year", yrs: "year", year: "year", years: "year",
};

interface ParsedDate {
  date: Date;
  /** The text named a year explicitly (otherwise "until" may roll to next year). */
  hasYear: boolean;
  /** The base carries a meaningful time of day ("now"). */
  hasTime: boolean;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  const idx = MONTHS.findIndex((m) => w.startsWith(m));
  if (idx < 0) return -1;
  // "march" ok, "marble" not: the word must be a prefix of the full month name.
  const full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][idx]!;
  return full.startsWith(w) || w === "sept" ? idx : -1;
}

function validYmd(y: number, m: number, d: number): Date | undefined {
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : undefined;
}

/** Parse a single date expression relative to `now`. */
export function parseDate(raw: string, now: Date): ParsedDate | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/,/g, "");
  const today = startOfDay(now);
  const y = now.getFullYear();
  const rel = (days: number, label: string): ParsedDate => ({ date: new Date(today.getFullYear(), today.getMonth(), today.getDate() + days), hasYear: true, hasTime: false, label });
  if (t === "now") return { date: new Date(now), hasYear: true, hasTime: true, label: "now" };
  if (t === "today") return rel(0, "today");
  if (t === "tomorrow") return rel(1, "tomorrow");
  if (t === "yesterday") return rel(-1, "yesterday");

  const holiday: Record<string, [number, number]> = {
    christmas: [11, 25], "christmas day": [11, 25], xmas: [11, 25], "christmas eve": [11, 24],
    "new year": [0, 1], "new years": [0, 1], "new year's": [0, 1], "new years day": [0, 1], "new year's day": [0, 1],
    "new years eve": [11, 31], "new year's eve": [11, 31], halloween: [9, 31], "valentines": [1, 14], "valentines day": [1, 14], "valentine's day": [1, 14],
  };
  const h = holiday[t];
  if (h) {
    let date = new Date(y, h[0], h[1]);
    if (date < today) date = new Date(y + 1, h[0], h[1]);
    return { date, hasYear: true, hasTime: false, label: t };
  }

  const wd = /^(?:(next|this|last) )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/.exec(t);
  if (wd && WEEKDAYS.some((w) => w.startsWith(t.replace(/^(next|this|last) /, "")))) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!));
    let diff = (target - today.getDay() + 7) % 7;
    if (wd[1] === "last") diff = diff === 0 ? -7 : diff - 7;
    else if (diff === 0 || wd[1] === "next") diff = diff === 0 ? 7 : diff;
    return rel(diff, t);
  }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) {
    const date = validYmd(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return date && { date, hasYear: true, hasTime: false, label: raw.trim() };
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (a > 12 && b <= 12) [a, b] = [b, a]; // 25/12 → day/month
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : y;
    const date = validYmd(yr, a - 1, b);
    return date && { date, hasYear: !!m[3], hasTime: false, label: raw.trim() };
  }
  // "dec 25", "december 25th 2026", "25 dec", "25th of december"
  m = /^([a-z.]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t) ?? null;
  let month = -1;
  let day = 0;
  let year: number | undefined;
  if (m) {
    month = monthIndex(m[1]!);
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  } else {
    m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z.]+)(?: (\d{4}))?$/.exec(t);
    if (m) {
      month = monthIndex(m[2]!);
      day = Number(m[1]);
      year = m[3] ? Number(m[3]) : undefined;
    }
  }
  if (month >= 0) {
    const date = validYmd(year ?? y, month, day);
    return date && { date, hasYear: year !== undefined, hasTime: false, label: raw.trim() };
  }
  return undefined;
}

interface Offset {
  n: number;
  unit: CalUnit;
}

/** "3 weeks", "1 year 2 months", "90d" → offsets. */
function parseOffsets(raw: string): Offset[] | undefined {
  const t = raw.trim().toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:and\s*|,\s*)?/gy;
  const out: Offset[] = [];
  let pos = 0;
  while (pos < t.length) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m) return undefined;
    const unit = UNIT_ALIASES[m[2]!];
    if (!unit) return undefined;
    const n = Number(m[1]);
    if (!Number.isInteger(n) && unit !== "hour" && unit !== "minute" && unit !== "day" && unit !== "week") return undefined;
    out.push({ n, unit });
    pos = re.lastIndex;
  }
  return out.length ? out : undefined;
}

function applyOffsets(base: Date, offsets: Offset[], sign: 1 | -1): Date {
  let d = new Date(base);
  for (const { n, unit } of offsets) {
    const k = n * sign;
    if (unit === "minute") d = new Date(d.getTime() + k * 60_000);
    else if (unit === "hour") d = new Date(d.getTime() + k * 3_600_000);
    else if (unit === "day" || unit === "week") {
      const days = unit === "week" ? k * 7 : k;
      const whole = Math.trunc(days);
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + whole, d.getHours(), d.getMinutes(), d.getSeconds());
      if (days !== whole) d = new Date(d.getTime() + (days - whole) * DAY_MS);
    } else {
      const months = unit === "year" ? k * 12 : k;
      const target = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes(), d.getSeconds());
      // Clamp Jan 31 + 1 month to Feb 28/29 instead of rolling into March.
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(d.getDate(), lastDay));
      d = target;
    }
  }
  return d;
}

export type DateResult =
  | { kind: "date"; date: Date; hasTime: boolean; expression: string }
  | { kind: "count"; days: number; unit: "day" | "week" | "month" | "year" | "hour" | "minute"; from: Date; to: Date; direction: "until" | "since" | "between"; target: string };

/** Whole calendar days from a to b (DST-safe). */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

/** Parse and evaluate a date query; undefined when the text is not one. */
export function parseDateQuery(query: string, now: Date): DateResult | undefined {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "");
  if (q.length < 3 || q.length > 80) return undefined;

  // "days until dec 25", "how many weeks till christmas", "days since jan 1"
  let m = /^(?:how many )?(days|weeks|months|years|hours|minutes) (until|till|til|to|since|from) (.+)$/.exec(q);
  if (m) {
    const target = parseDate(m[3]!, now);
    if (!target) return undefined;
    const since = m[2] === "since" || m[2] === "from";
    let to = target.date;
    if (!since && !target.hasYear && startOfDay(to) < startOfDay(now)) to = new Date(to.getFullYear() + 1, to.getMonth(), to.getDate());
    const unit = m[1]!.replace(/s$/, "") as "day" | "week" | "month" | "year" | "hour" | "minute";
    return { kind: "count", days: since ? daysBetween(to, now) : daysBetween(now, to), unit, from: since ? to : now, to: since ? now : to, direction: since ? "since" : "until", target: m[3]! };
  }
  // "days between mar 1 and jun 30"
  m = /^(?:how many )?(days|weeks|months|years) between (.+?) and (.+)$/.exec(q);
  if (m) {
    const a = parseDate(m[2]!, now);
    const b = parseDate(m[3]!, now);
    if (!a || !b) return undefined;
    const unit = m[1]!.replace(/s$/, "") as "day" | "week" | "month" | "year";
    return { kind: "count", days: Math.abs(daysBetween(a.date, b.date)), unit, from: a.date, to: b.date, direction: "between", target: `${m[2]} and ${m[3]}` };
  }
  // "today + 3 weeks", "dec 25 - 10 days", "now + 90 min"
  m = /^(.+) ?([+-]) ?(\d[^+-]*)$/.exec(q);
  if (m) {
    const base = parseDate(m[1]!, now);
    const offsets = parseOffsets(m[3]!);
    if (base && offsets) {
      const timed = base.hasTime || offsets.some((o) => o.unit === "hour" || o.unit === "minute");
      // "today + 3 hours" means three hours from now, not from midnight.
      const start = timed && !base.hasTime && base.label === "today" ? now : base.date;
      return { kind: "date", date: applyOffsets(start, offsets, m[2] === "-" ? -1 : 1), hasTime: timed, expression: q };
    }
  }
  // "3 weeks from now", "10 days from today", "2 weeks after dec 25", "5 days before christmas"
  m = /^(.+?) (from|after|before) (.+)$/.exec(q);
  if (m) {
    const offsets = parseOffsets(m[1]!);
    const base = parseDate(m[3]!, now);
    if (offsets && base) {
      const timed = base.hasTime || offsets.some((o) => o.unit === "hour" || o.unit === "minute");
      const start = timed && !base.hasTime ? now : base.date;
      return { kind: "date", date: applyOffsets(start, offsets, m[2] === "before" ? -1 : 1), hasTime: timed, expression: q };
    }
  }
  // "2 weeks ago", "in 3 days"
  m = /^(.+) ago$/.exec(q) ?? null;
  if (m) {
    const offsets = parseOffsets(m[1]!);
    if (offsets) {
      const timed = offsets.some((o) => o.unit === "hour" || o.unit === "minute");
      return { kind: "date", date: applyOffsets(timed ? now : startOfDay(now), offsets, -1), hasTime: timed, expression: q };
    }
  }
  m = /^in (\d.+)$/.exec(q);
  if (m) {
    const offsets = parseOffsets(m[1]!);
    if (offsets) {
      const timed = offsets.some((o) => o.unit === "hour" || o.unit === "minute");
      return { kind: "date", date: applyOffsets(timed ? now : startOfDay(now), offsets, 1), hasTime: timed, expression: q };
    }
  }
  return undefined;
}

export function formatDate(d: Date, withTime = false): string {
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  return withTime ? `${date}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : date;
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "9 weeks, 3 days" breakdown of a day count. */
export function describeDays(days: number): string {
  const abs = Math.abs(days);
  const parts: string[] = [];
  const weeks = Math.floor(abs / 7);
  const rest = abs % 7;
  if (weeks) parts.push(`${weeks} week${weeks === 1 ? "" : "s"}`);
  if (rest || !weeks) parts.push(`${rest} day${rest === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Headline value for a count result in its requested unit ("66 days", "9.4 weeks", "2 months"). */
export function countValue(r: Extract<DateResult, { kind: "count" }>): { value: number; label: string } {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  switch (r.unit) {
    case "week": {
      const v = Math.round((r.days / 7) * 10) / 10;
      return { value: v, label: plural(v, "week") };
    }
    case "month": {
      // Whole calendar months, then the remainder in days.
      const [a, b] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from];
      let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
      if (b.getDate() < a.getDate()) months--;
      const anchor = applyOffsets(startOfDay(a), [{ n: months, unit: "month" }], 1);
      const days = daysBetween(anchor, b);
      return { value: months, label: days ? `${plural(months, "month")}, ${plural(days, "day")}` : plural(months, "month") };
    }
    case "year": {
      const v = Math.round((r.days / 365.2425) * 100) / 100;
      return { value: v, label: plural(v, "year") };
    }
    case "hour": {
      const v = Math.round(Math.abs(r.to.getTime() - r.from.getTime()) / 3_600_000);
      return { value: v, label: plural(v, "hour") };
    }
    case "minute": {
      const v = Math.round(Math.abs(r.to.getTime() - r.from.getTime()) / 60_000);
      return { value: v, label: plural(v, "minute") };
    }
    default:
      return { value: r.days, label: plural(r.days, "day") };
  }
}
