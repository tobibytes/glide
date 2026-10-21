/** Date formatting (Unicode/date-fns style tokens) and relative offsets for {date}/{time} placeholders. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function token(d: Date, tok: string): string | undefined {
  const h = d.getHours();
  switch (tok) {
    case "yyyy":
      return String(d.getFullYear());
    case "yy":
      return pad(d.getFullYear() % 100);
    case "MMMM":
      return MONTHS[d.getMonth()];
    case "MMM":
      return MONTHS[d.getMonth()]!.slice(0, 3);
    case "MM":
      return pad(d.getMonth() + 1);
    case "M":
      return String(d.getMonth() + 1);
    case "dd":
      return pad(d.getDate());
    case "d":
      return String(d.getDate());
    case "EEEE":
      return DAYS[d.getDay()];
    case "EEE":
      return DAYS[d.getDay()]!.slice(0, 3);
    case "HH":
      return pad(h);
    case "H":
      return String(h);
    case "hh":
      return pad(h % 12 || 12);
    case "h":
      return String(h % 12 || 12);
    case "mm":
      return pad(d.getMinutes());
    case "m":
      return String(d.getMinutes());
    case "ss":
      return pad(d.getSeconds());
    case "s":
      return String(d.getSeconds());
    case "SSS":
      return pad(d.getMilliseconds(), 3);
    case "a":
      return h < 12 ? "AM" : "PM";
    case "ww":
      return pad(isoWeek(d));
    case "w":
      return String(isoWeek(d));
    case "Q":
      return String(Math.floor(d.getMonth() / 3) + 1);
    case "X":
      return String(Math.floor(d.getTime() / 1000));
    case "x":
      return String(d.getTime());
  }
  return undefined;
}

const TOKENS = ["yyyy", "MMMM", "EEEE", "SSS", "MMM", "EEE", "yy", "MM", "dd", "HH", "hh", "mm", "ss", "ww", "M", "d", "H", "h", "m", "s", "a", "w", "Q", "X", "x"];

/** Format with tokens like `yyyy-MM-dd HH:mm`, `EEEE, MMMM d`. Text in single quotes is literal (`''` is a quote). */
export function formatDate(d: Date, format: string): string {
  let out = "";
  let i = 0;
  while (i < format.length) {
    const c = format[i]!;
    if (c === "'") {
      if (format[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      // Quoted literal; '' inside it is an apostrophe.
      let j = i + 1;
      while (j < format.length) {
        if (format[j] === "'" && format[j + 1] === "'") {
          out += "'";
          j += 2;
        } else if (format[j] === "'") break;
        else out += format[j++];
      }
      i = j + 1;
      continue;
    }
    const tok = TOKENS.find((t) => format.startsWith(t, i));
    const v = tok ? token(d, tok) : undefined;
    if (tok && v !== undefined) {
      out += v;
      i += tok.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Apply offsets like "+1d", "-2w", "+1d 3h", "+1M", "-30m", "1y". Units: y M w d h m s.
 * A sign applies to the following terms until another sign. Unparseable input leaves the date unchanged.
 */
export function applyDateOffset(base: Date, offset: string): Date {
  const d = new Date(base.getTime());
  const re = /([+-])?\s*(\d+)\s*(y|M|w|d|h|m|s)/g;
  let sign = 1;
  let m: RegExpExecArray | null;
  let consumed = "";
  while ((m = re.exec(offset))) {
    if (m[1]) sign = m[1] === "-" ? -1 : 1;
    const n = Number(m[2]) * sign;
    consumed += m[0];
    switch (m[3]) {
      case "y":
        d.setFullYear(d.getFullYear() + n);
        break;
      case "M": {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + n);
        // Clamp: Jan 31 + 1M = Feb 28/29, not Mar 3.
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      case "w":
        d.setDate(d.getDate() + 7 * n);
        break;
      case "d":
        d.setDate(d.getDate() + n);
        break;
      case "h":
        d.setHours(d.getHours() + n);
        break;
      case "m":
        d.setMinutes(d.getMinutes() + n);
        break;
      case "s":
        d.setSeconds(d.getSeconds() + n);
        break;
    }
  }
  return consumed ? d : new Date(base.getTime());
}
