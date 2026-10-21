/**
 * Natural-language due dates for "Create Reminder": pulls a date/time phrase out of the text and
 * leaves the rest as the title. "Call mom tomorrow 9am" → { title: "Call mom", due: tomorrow 09:00 }.
 * Supported: today/tonight/tomorrow/day after tomorrow, in N minutes/hours/days/weeks/months,
 * (next|this|on) weekday, next week/month, this weekend, month-name dates ("dec 25", "25 december"),
 * 2026-11-01, 11/1, and times (9am, 9:30 pm, 17:45, at 5, noon, midnight, morning/afternoon/evening).
 * A date without a time is an all-day reminder; a time without a date is today (tomorrow once past).
 */
import { describeDue } from "./format";

export interface ParsedReminder {
  title: string;
  due?: Date;
  allDay: boolean;
  /** The text that was read as the due date (for the preview), e.g. "tomorrow 9am". */
  phrase?: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, half: 0.5 };
const PERIODS: Record<string, number> = { morning: 9, noon: 12, afternoon: 15, evening: 18, tonight: 20, night: 20, midnight: 0 };

type Unit = "minute" | "hour" | "day" | "week" | "month";
function unitOf(word: string): Unit | undefined {
  const w = word.toLowerCase();
  if (/^(m|min|mins|minute|minutes)$/.test(w)) return "minute";
  if (/^(h|hr|hrs|hour|hours)$/.test(w)) return "hour";
  if (/^(d|day|days)$/.test(w)) return "day";
  if (/^(w|wk|wks|week|weeks)$/.test(w)) return "week";
  if (/^(mo|month|months)$/.test(w)) return "month";
  return undefined;
}

function weekdayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  const idx = MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
  return idx >= 0 && (MONTHS[idx]!.startsWith(w) || w === "sept") ? idx : -1;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

interface Span {
  start: number;
  end: number;
}

interface DatePart extends Span {
  day?: Date; // local midnight
  instant?: Date; // relative offsets with sub-day precision
  defaultHour?: number; // "tonight" → 20:00
}

interface TimePart extends Span {
  hour: number;
  minute: number;
}

/** First match of `re` (global, case-insensitive) as a span plus groups. */
function find(text: string, re: RegExp): (Span & { m: RegExpExecArray }) | undefined {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, m } : undefined;
}

function findDate(t: string, now: Date): DatePart | undefined {
  const today = startOfDay(now);
  let s;

  if ((s = find(t, /\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|half an?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo)\b/gi))) {
    const raw = s.m[1]!.toLowerCase().replace(/\s+an?$/, "");
    const n = Number.isNaN(Number(raw)) ? (NUMBER_WORDS[raw] ?? 1) : Number(raw);
    const unit = unitOf(s.m[2]!)!;
    if (unit === "minute" || unit === "hour") return { ...s, instant: new Date(now.getTime() + n * (unit === "minute" ? 60_000 : 3_600_000)) };
    if (unit === "day") return { ...s, day: addDays(today, Math.round(n)) };
    if (unit === "week") return { ...s, day: addDays(today, Math.round(n * 7)) };
    return { ...s, day: new Date(today.getFullYear(), today.getMonth() + Math.round(n), today.getDate()) };
  }
  if ((s = find(t, /\b(?:the\s+)?day\s+after\s+tomorrow\b/gi))) return { ...s, day: addDays(today, 2) };
  if ((s = find(t, /\b(tomorrow|tmrw|tmr|tomorow)(\s+(morning|afternoon|evening|night))?\b/gi))) return { ...s, day: addDays(today, 1), defaultHour: s.m[3] ? PERIODS[s.m[3].toLowerCase()] : undefined };
  if ((s = find(t, /\btonight\b/gi))) return { ...s, day: today, defaultHour: PERIODS.tonight };
  if ((s = find(t, /\b(?:this\s+)?(morning|afternoon|evening)\b/gi)) && /^this\s/i.test(s.m[0])) return { ...s, day: today, defaultHour: PERIODS[s.m[1]!.toLowerCase()] };
  if ((s = find(t, /\btoday\b/gi))) return { ...s, day: today };
  if ((s = find(t, /\b(next|this)\s+weekend\b/gi))) {
    const sat = addDays(today, (6 - today.getDay() + 7) % 7);
    return { ...s, day: s.m[1]!.toLowerCase() === "next" ? addDays(sat, 7) : sat };
  }
  if ((s = find(t, /\bnext\s+(week|month|year)\b/gi))) {
    const u = s.m[1]!.toLowerCase();
    if (u === "week") return { ...s, day: addDays(today, ((1 - today.getDay() + 7) % 7) || 7) }; // next Monday
    if (u === "month") return { ...s, day: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
    return { ...s, day: new Date(today.getFullYear() + 1, 0, 1) };
  }
  // Bare weekdays must be spelled out ("sat" and "sun" are ordinary words); abbreviations need next/this/on.
  if ((s = find(t, new RegExp(`\\b(?:(next|this|on|coming)\\s+${WEEKDAY_RE}|(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\\b`, "gi")))) {
    const wd = weekdayIndex(s.m[2] ?? s.m[3]!);
    let diff = (wd - today.getDay() + 7) % 7;
    // "friday" on a Friday means next week's; "this friday" on a Friday is today.
    if (diff === 0 && s.m[1]?.toLowerCase() !== "this") diff = 7;
    return { ...s, day: addDays(today, diff) };
  }
  if ((s = find(t, /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g))) {
    const d = valid(+s.m[1]!, +s.m[2]! - 1, +s.m[3]!);
    if (d) return { ...s, day: d };
  }
  const withYear = (m: number, d: number, y?: string): Date | undefined => {
    if (y) return valid(y.length === 2 ? 2000 + +y : +y, m, d);
    const thisYear = valid(today.getFullYear(), m, d);
    return thisYear && thisYear < today ? valid(today.getFullYear() + 1, m, d) : thisYear;
  };
  if ((s = find(t, new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi")))) {
    const m = monthIndex(s.m[0].replace(/^on\s+/i, "").split(/\s+/)[0]!);
    const d = m >= 0 ? withYear(m, +s.m[2]!, s.m[3]) : undefined;
    if (d) return { ...s, day: d };
  }
  if ((s = find(t, new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, "gi")))) {
    const word = s.m[0].replace(/^(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\s+(of\s+)?/i, "").split(/[\s,]+/)[0]!;
    const m = monthIndex(word);
    const d = m >= 0 ? withYear(m, +s.m[1]!, s.m[3]) : undefined;
    if (d) return { ...s, day: d };
  }
  // 11/3 only with a year, after on/by/due, or at the very end: "1/2 cup flour" is not January 2.
  if ((s = find(t, /\b(on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/gi)) && (s.m[1] || s.m[4] || s.end === t.length)) {
    const d = withYear(+s.m[2]! - 1, +s.m[3]!, s.m[4]);
    if (d) return { ...s, day: d };
  }
  return undefined;
}

function valid(y: number, m: number, d: number): Date | undefined {
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : undefined;
}

function findTime(t: string): TimePart | undefined {
  let s;
  if ((s = find(t, /\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|a\.m\.|p\.m\.)|(a|p))(?![a-z])/gi))) {
    let h = +s.m[1]!;
    const min = s.m[2] ? +s.m[2] : 0;
    if (h < 1 || h > 12 || min > 59) return undefined;
    const pm = (s.m[3] ?? s.m[4]!).toLowerCase().startsWith("p");
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return { ...s, hour: h, minute: min };
  }
  if ((s = find(t, /\b(?:at\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/gi))) return { ...s, hour: +s.m[1]!, minute: +s.m[2]! };
  if ((s = find(t, /\b(?:at|@)\s*(\d{1,2})\b(?!\s*(?:\/|-|minutes?|mins?|hours?|days?|weeks?))/gi))) {
    const h = +s.m[1]!;
    if (h > 23) return undefined;
    // "at 5" means 5 pm; mornings are written "at 9" too, so 7–11 stay am.
    return { ...s, hour: h >= 1 && h <= 6 ? h + 12 : h, minute: 0 };
  }
  if ((s = find(t, /\b(?:at\s+)?(noon|midday|midnight)\b/gi))) return { ...s, hour: s.m[1]!.toLowerCase() === "midnight" ? 0 : 12, minute: 0 };
  if ((s = find(t, /\b(?:in\s+the\s+)?(morning|afternoon|evening)\b/gi))) return { ...s, hour: PERIODS[s.m[1]!.toLowerCase()]!, minute: 0 };
  return undefined;
}

function cut(text: string, spans: Span[]): string {
  let out = text;
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, sp.start) + " " + out.slice(sp.end);
  return out
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\s+|^)(?:at|on|by|due|for)$/i, "")
    .replace(/^(?:remind\s+me\s+(?:to\s+)?|to\s+)/i, "")
    .replace(/[\s,;:–—-]+$/, "")
    .trim();
}

export function parseReminderText(input: string, now: Date = new Date()): ParsedReminder {
  const text = input.replace(/\s+/g, " ").trim();
  const date = findDate(text, now);
  // Look for a time outside the date phrase so "in 2 hours" never doubles as "at 2".
  const masked = date ? text.slice(0, date.start) + " ".repeat(date.end - date.start) + text.slice(date.end) : text;
  const time = date?.instant ? undefined : findTime(masked);
  const spans = [date, time].filter((s): s is DatePart | TimePart => !!s);
  if (!spans.length) return { title: cut(text, []), allDay: false };

  const phrase = spans
    .sort((a, b) => a.start - b.start)
    .map((s) => text.slice(s.start, s.end).trim())
    .join(" ");
  const title = cut(text, spans) || text;
  if (date?.instant) return { title, due: date.instant, allDay: false, phrase };

  let day = date?.day;
  const hour = time?.hour ?? date?.defaultHour;
  const minute = time?.minute ?? 0;
  if (hour === undefined) return { title, due: day, allDay: true, phrase };
  if (!day) {
    day = startOfDay(now);
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    if (candidate.getTime() <= now.getTime()) day = addDays(day, 1);
  }
  return { title, due: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute), allDay: false, phrase };
}

/** One-line preview, e.g. "Due Tomorrow, 9:00 AM". */
export function previewDue(p: ParsedReminder, now: Date = new Date()): string {
  return p.due ? `Due ${describeDue(p.due, p.allDay, now)}` : "No due date";
}
