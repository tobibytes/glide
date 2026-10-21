/**
 * Time zones: "time in tokyo", "nyc time", "5pm london in tokyo", "9:30am pst to cet", "3pm in sydney".
 * Zone maths uses Intl (IANA database shipped with Node/Chromium), so DST is handled for free.
 */

type Alias = [zone: string, label: string];

/** Common names, abbreviations and countries that are not the last segment of an IANA id. */
const ALIASES: Record<string, Alias> = {
  nyc: ["America/New_York", "New York"], "new york city": ["America/New_York", "New York"], ny: ["America/New_York", "New York"],
  boston: ["America/New_York", "Boston"], miami: ["America/New_York", "Miami"], atlanta: ["America/New_York", "Atlanta"], washington: ["America/New_York", "Washington"],
  dc: ["America/New_York", "Washington"], philadelphia: ["America/New_York", "Philadelphia"], toronto: ["America/Toronto", "Toronto"],
  sf: ["America/Los_Angeles", "San Francisco"], "san francisco": ["America/Los_Angeles", "San Francisco"], la: ["America/Los_Angeles", "Los Angeles"],
  seattle: ["America/Los_Angeles", "Seattle"], "silicon valley": ["America/Los_Angeles", "San Francisco"], "san jose": ["America/Los_Angeles", "San Jose"],
  "las vegas": ["America/Los_Angeles", "Las Vegas"], portland: ["America/Los_Angeles", "Portland"], "san diego": ["America/Los_Angeles", "San Diego"],
  austin: ["America/Chicago", "Austin"], dallas: ["America/Chicago", "Dallas"], houston: ["America/Chicago", "Houston"], denver: ["America/Denver", "Denver"],
  phoenix: ["America/Phoenix", "Phoenix"], montreal: ["America/Toronto", "Montreal"], "mexico city": ["America/Mexico_City", "Mexico City"],
  "rio": ["America/Sao_Paulo", "Rio de Janeiro"], "rio de janeiro": ["America/Sao_Paulo", "Rio de Janeiro"],
  uk: ["Europe/London", "London"], england: ["Europe/London", "London"], britain: ["Europe/London", "London"], ireland: ["Europe/Dublin", "Dublin"],
  france: ["Europe/Paris", "Paris"], germany: ["Europe/Berlin", "Berlin"], munich: ["Europe/Berlin", "Munich"], frankfurt: ["Europe/Berlin", "Frankfurt"],
  hamburg: ["Europe/Berlin", "Hamburg"], spain: ["Europe/Madrid", "Madrid"], barcelona: ["Europe/Madrid", "Barcelona"], italy: ["Europe/Rome", "Rome"],
  milan: ["Europe/Rome", "Milan"], netherlands: ["Europe/Amsterdam", "Amsterdam"], switzerland: ["Europe/Zurich", "Zurich"], geneva: ["Europe/Zurich", "Geneva"],
  sweden: ["Europe/Stockholm", "Stockholm"], norway: ["Europe/Oslo", "Oslo"], poland: ["Europe/Warsaw", "Warsaw"], greece: ["Europe/Athens", "Athens"],
  turkey: ["Europe/Istanbul", "Istanbul"], russia: ["Europe/Moscow", "Moscow"], ukraine: ["Europe/Kyiv", "Kyiv"], kiev: ["Europe/Kyiv", "Kyiv"],
  portugal: ["Europe/Lisbon", "Lisbon"], belgium: ["Europe/Brussels", "Brussels"], austria: ["Europe/Vienna", "Vienna"],
  nigeria: ["Africa/Lagos", "Lagos"], abuja: ["Africa/Lagos", "Abuja"], ghana: ["Africa/Accra", "Accra"], kenya: ["Africa/Nairobi", "Nairobi"],
  egypt: ["Africa/Cairo", "Cairo"], "south africa": ["Africa/Johannesburg", "Johannesburg"], "cape town": ["Africa/Johannesburg", "Cape Town"],
  morocco: ["Africa/Casablanca", "Casablanca"], ethiopia: ["Africa/Addis_Ababa", "Addis Ababa"],
  dubai: ["Asia/Dubai", "Dubai"], uae: ["Asia/Dubai", "Dubai"], "abu dhabi": ["Asia/Dubai", "Abu Dhabi"], israel: ["Asia/Jerusalem", "Jerusalem"],
  "tel aviv": ["Asia/Jerusalem", "Tel Aviv"], "saudi arabia": ["Asia/Riyadh", "Riyadh"], qatar: ["Asia/Qatar", "Doha"], doha: ["Asia/Qatar", "Doha"],
  india: ["Asia/Kolkata", "India"], mumbai: ["Asia/Kolkata", "Mumbai"], delhi: ["Asia/Kolkata", "Delhi"], "new delhi": ["Asia/Kolkata", "New Delhi"],
  bangalore: ["Asia/Kolkata", "Bangalore"], bengaluru: ["Asia/Kolkata", "Bengaluru"], chennai: ["Asia/Kolkata", "Chennai"], pakistan: ["Asia/Karachi", "Karachi"],
  china: ["Asia/Shanghai", "China"], beijing: ["Asia/Shanghai", "Beijing"], shenzhen: ["Asia/Shanghai", "Shenzhen"], "hong kong": ["Asia/Hong_Kong", "Hong Kong"],
  hk: ["Asia/Hong_Kong", "Hong Kong"], taiwan: ["Asia/Taipei", "Taipei"], japan: ["Asia/Tokyo", "Tokyo"], osaka: ["Asia/Tokyo", "Osaka"], kyoto: ["Asia/Tokyo", "Kyoto"],
  korea: ["Asia/Seoul", "Seoul"], "south korea": ["Asia/Seoul", "Seoul"], singapore: ["Asia/Singapore", "Singapore"], thailand: ["Asia/Bangkok", "Bangkok"],
  vietnam: ["Asia/Ho_Chi_Minh", "Ho Chi Minh City"], hanoi: ["Asia/Bangkok", "Hanoi"], indonesia: ["Asia/Jakarta", "Jakarta"], bali: ["Asia/Makassar", "Bali"],
  philippines: ["Asia/Manila", "Manila"], malaysia: ["Asia/Kuala_Lumpur", "Kuala Lumpur"],
  australia: ["Australia/Sydney", "Sydney"], canberra: ["Australia/Sydney", "Canberra"], "new zealand": ["Pacific/Auckland", "Auckland"], nz: ["Pacific/Auckland", "Auckland"],
  wellington: ["Pacific/Auckland", "Wellington"], hawaii: ["Pacific/Honolulu", "Honolulu"], alaska: ["America/Anchorage", "Anchorage"],
  brazil: ["America/Sao_Paulo", "São Paulo"], argentina: ["America/Argentina/Buenos_Aires", "Buenos Aires"], chile: ["America/Santiago", "Santiago"],
  colombia: ["America/Bogota", "Bogotá"], peru: ["America/Lima", "Lima"], mexico: ["America/Mexico_City", "Mexico City"], canada: ["America/Toronto", "Toronto"],
  vancouver: ["America/Vancouver", "Vancouver"], calgary: ["America/Edmonton", "Calgary"],
  // Abbreviations: mapped to a representative zone so DST follows the place people mean.
  utc: ["UTC", "UTC"], gmt: ["Etc/GMT", "GMT"], z: ["UTC", "UTC"], zulu: ["UTC", "UTC"],
  est: ["America/New_York", "ET"], edt: ["America/New_York", "ET"], et: ["America/New_York", "ET"], eastern: ["America/New_York", "ET"],
  cst: ["America/Chicago", "CT"], cdt: ["America/Chicago", "CT"], ct: ["America/Chicago", "CT"], central: ["America/Chicago", "CT"],
  mst: ["America/Denver", "MT"], mdt: ["America/Denver", "MT"], mt: ["America/Denver", "MT"], mountain: ["America/Denver", "MT"],
  pst: ["America/Los_Angeles", "PT"], pdt: ["America/Los_Angeles", "PT"], pt: ["America/Los_Angeles", "PT"], pacific: ["America/Los_Angeles", "PT"],
  akst: ["America/Anchorage", "AKT"], hst: ["Pacific/Honolulu", "HST"],
  bst: ["Europe/London", "UK"], wet: ["Europe/Lisbon", "WET"], cet: ["Europe/Paris", "CET"], cest: ["Europe/Paris", "CET"], eet: ["Europe/Athens", "EET"],
  eest: ["Europe/Athens", "EET"], msk: ["Europe/Moscow", "MSK"], wat: ["Africa/Lagos", "WAT"], cat: ["Africa/Maputo", "CAT"], eat: ["Africa/Nairobi", "EAT"],
  sast: ["Africa/Johannesburg", "SAST"], ist: ["Asia/Kolkata", "IST"], pkt: ["Asia/Karachi", "PKT"], gst: ["Asia/Dubai", "GST"],
  sgt: ["Asia/Singapore", "SGT"], hkt: ["Asia/Hong_Kong", "HKT"], jst: ["Asia/Tokyo", "JST"], kst: ["Asia/Seoul", "KST"],
  aest: ["Australia/Sydney", "AET"], aedt: ["Australia/Sydney", "AET"], acst: ["Australia/Adelaide", "ACT"], awst: ["Australia/Perth", "AWT"],
  nzst: ["Pacific/Auckland", "NZT"], nzdt: ["Pacific/Auckland", "NZT"],
};

let cityIndex: Map<string, Alias> | undefined;

/** "america/new_york" and "new york" → America/New_York, built from Intl's zone list once. */
function cities(): Map<string, Alias> {
  if (cityIndex) return cityIndex;
  cityIndex = new Map();
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  for (const zone of [...zones, "UTC"]) {
    const city = zone.split("/").pop()!.replace(/_/g, " ");
    cityIndex.set(zone.toLowerCase(), [zone, city]);
    if (!cityIndex.has(city.toLowerCase())) cityIndex.set(city.toLowerCase(), [zone, city]);
  }
  return cityIndex;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ZoneRef {
  zone: string;
  label: string;
}

/** Resolve "tokyo", "NYC", "pst", "Europe/Paris", "utc+3", "local". */
export function lookupZone(raw: string, localZone: string): ZoneRef | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  if (!t) return undefined;
  if (t === "local" || t === "here" || t === "my time" || t === "local time") return { zone: localZone, label: "Local" };
  const off = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (off) {
    const h = Number(off[2]);
    if (h > 14) return undefined;
    // Etc/GMT zones have inverted signs (Etc/GMT-3 is UTC+3); minutes need an explicit offset zone.
    const zone = off[3] && off[3] !== "00" ? `${off[1]}${String(h).padStart(2, "0")}:${off[3]}` : h === 0 ? "UTC" : `Etc/GMT${off[1] === "+" ? "-" : "+"}${h}`;
    return validZone(zone) ? { zone, label: `UTC${off[1]}${h}${off[3] && off[3] !== "00" ? `:${off[3]}` : ""}` } : undefined;
  }
  const hit = ALIASES[t] ?? cities().get(t);
  return hit ? { zone: hit[0], label: hit[1] } : undefined;
}

interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function wallIn(zone: string, instant: number): Wall {
  let f = partsFormatter.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    partsFormatter.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(instant))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute! };
}

/** Minutes east of UTC for `zone` at `instant`. */
export function offsetMinutes(zone: string, instant: number): number {
  const w = wallIn(zone, instant);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

/** The instant when the wall clock in `zone` shows the given time (DST gaps resolve forward). */
export function wallToInstant(zone: string, w: Wall): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const o1 = offsetMinutes(zone, guess);
  let inst = guess - o1 * 60_000;
  const o2 = offsetMinutes(zone, inst);
  if (o2 !== o1) inst = guess - o2 * 60_000;
  return inst;
}

/** "5pm", "5:30 pm", "17:00", "noon", "midnight" → {hour, minute}. Bare "5" is not a time. */
export function parseClock(raw: string): { hour: number; minute: number } | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "noon" || t === "midday") return { hour: 12, minute: 0 };
  if (t === "midnight") return { hour: 0, minute: 0 };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return undefined;
  if (m[3]) {
    if (hour < 1 || hour > 12) return undefined;
    const pm = m[3].startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) return undefined;
  return { hour, minute };
}

export interface TimeZoneResult {
  /** "1:00 AM" */
  time: string;
  /** "Tue, Oct 21" */
  date: string;
  /** "GMT+9" */
  offset: string;
  to: ZoneRef;
  from?: ZoneRef;
  /** Source wall time when converting ("5:00 PM"). */
  fromTime?: string;
  /** Target calendar day minus source calendar day (-1, 0, +1). */
  dayDelta: number;
  instant: number;
  /** ISO 8601 with the target zone's offset, e.g. 2026-10-21T01:00:00+09:00 */
  iso: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string, kind: "time" | "date" | "offset"): Intl.DateTimeFormat {
  const key = `${zone}|${kind}`;
  let f = fmtCache.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === "time" ? { hour: "numeric", minute: "2-digit" } : kind === "date" ? { weekday: "short", month: "short", day: "numeric" } : { timeZoneName: "shortOffset" };
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

export function formatOffset(zone: string, instant: number): string {
  return fmt(zone, "offset").formatToParts(new Date(instant)).find((p) => p.type === "timeZoneName")?.value ?? zone;
}

function isoIn(zone: string, instant: number): string {
  const w = wallIn(zone, instant);
  const off = offsetMinutes(zone, instant);
  const pad = (n: number, l = 2) => String(Math.abs(n)).padStart(l, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function dayNumber(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day) / 86_400_000;
}

function describe(instant: number, to: ZoneRef, from: ZoneRef | undefined, sourceZone: string): TimeZoneResult {
  return {
    time: fmt(to.zone, "time").format(new Date(instant)),
    date: fmt(to.zone, "date").format(new Date(instant)),
    offset: formatOffset(to.zone, instant),
    to,
    from,
    fromTime: from ? fmt(from.zone, "time").format(new Date(instant)) : undefined,
    dayDelta: dayNumber(wallIn(to.zone, instant)) - dayNumber(wallIn(sourceZone, instant)),
    instant,
    iso: isoIn(to.zone, instant),
  };
}

const SEP = String.raw`\s+(?:in|to|into|->|→|=)\s+`;

/** Parse and evaluate a time-zone query; undefined when the text is not one. */
export function parseTimeZoneQuery(query: string, now: number, localZone: string): TimeZoneResult | undefined {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "");
  if (q.length < 4 || q.length > 60) return undefined;
  const local: ZoneRef = { zone: localZone, label: "Local" };

  // "time in tokyo", "what time is it in nyc", "now in london", "tokyo time", "time tokyo"
  const cur =
    /^(?:what(?:'s| is)? the time in|what time is it in|current time in|time (?:in|at)|now in|time)\s+(.+)$/.exec(q) ?? /^(.+?)\s+(?:time|now)$/.exec(q);
  if (cur) {
    const to = lookupZone(cur[1]!, localZone);
    if (to) return describe(now, to, undefined, localZone);
  }

  // "<clock> <zone> in <zone>", "<clock> in <zone>", "<clock> <zone>"
  const conv = new RegExp(`^(.+?)${SEP}(.+)$`).exec(q);
  const [left, right] = conv ? [conv[1]!, conv[2]!] : [q, undefined];
  const lm = /^(noon|midnight|midday|\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|a|p)?)(?:\s+(.+))?$/.exec(left);
  if (!lm) return undefined;
  const clock = parseClock(lm[1]!);
  if (!clock) return undefined;
  const from = lm[2] ? lookupZone(lm[2], localZone) : undefined;
  if (lm[2] && !from) return undefined;
  const to = right ? lookupZone(right, localZone) : undefined;
  if (right && !to) return undefined;
  if (!from && !to) return undefined; // a bare "5pm" is not a time-zone question
  const src = from ?? local;
  const dst = to ?? local;
  const today = wallIn(src.zone, now);
  const instant = wallToInstant(src.zone, { year: today.year, month: today.month, day: today.day, hour: clock.hour, minute: clock.minute });
  return describe(instant, dst, src, src.zone);
}
