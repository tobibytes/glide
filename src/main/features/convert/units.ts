/**
 * Unit conversion: "5 km in miles", "100f to c", "3 gb in mb", "5 ft 10 in to cm", "90 min in hours".
 * Every unit converts through a base unit of its dimension (m, kg, L, K, m², m/s, byte, s).
 */
import { parseAmount } from "./format";

export type Dimension = "length" | "mass" | "volume" | "temperature" | "area" | "speed" | "data" | "time";

export interface UnitDef {
  id: string;
  dim: Dimension;
  /** base = (value + offset) * factor */
  factor: number;
  offset?: number;
  symbol: string;
  name: string;
}

export const DIMENSION_LABEL: Record<Dimension, string> = {
  length: "Length",
  mass: "Mass",
  volume: "Volume",
  temperature: "Temperature",
  area: "Area",
  speed: "Speed",
  data: "Data Size",
  time: "Duration",
};

type Spec = [id: string, factor: number, symbol: string, name: string, aliases: string[], offset?: number];

const SPECS: Record<Dimension, Spec[]> = {
  length: [
    ["nm", 1e-9, "nm", "nanometers", ["nanometer", "nanometre"]],
    ["um", 1e-6, "µm", "micrometers", ["µm", "micrometer", "micrometre", "micron"]],
    ["mm", 1e-3, "mm", "millimeters", ["millimeter", "millimetre"]],
    ["cm", 1e-2, "cm", "centimeters", ["centimeter", "centimetre"]],
    ["m", 1, "m", "meters", ["meter", "metre", "mtr"]],
    ["km", 1e3, "km", "kilometers", ["kilometer", "kilometre", "kms", "klick"]],
    ["in", 0.0254, "in", "inches", ["inch", "inches", '"', "″"]],
    ["ft", 0.3048, "ft", "feet", ["foot", "feet", "'", "′"]],
    ["yd", 0.9144, "yd", "yards", ["yard", "yds"]],
    ["mi", 1609.344, "mi", "miles", ["mile"]],
    ["nmi", 1852, "nmi", "nautical miles", ["nautical mile", "nautical miles"]],
    ["au", 149_597_870_700, "au", "astronomical units", ["astronomical unit"]],
    ["ly", 9_460_730_472_580_800, "ly", "light years", ["light year", "light-year", "lightyear"]],
  ],
  mass: [
    ["mg", 1e-6, "mg", "milligrams", ["milligram", "milligramme"]],
    ["g", 1e-3, "g", "grams", ["gram", "gramme", "gm", "gms"]],
    ["kg", 1, "kg", "kilograms", ["kilogram", "kilogramme", "kilo", "kgs"]],
    ["t", 1000, "t", "tonnes", ["tonne", "metric ton", "metric tons"]],
    ["oz", 0.028349523125, "oz", "ounces", ["ounce"]],
    ["lb", 0.45359237, "lb", "pounds", ["lbs", "pound"]],
    ["st", 6.35029318, "st", "stone", ["stone", "stones"]],
    ["ton", 907.18474, "ton", "US tons", ["ton", "tons", "short ton", "short tons"]],
  ],
  volume: [
    ["ml", 1e-3, "mL", "milliliters", ["milliliter", "millilitre", "cc"]],
    ["cl", 1e-2, "cL", "centiliters", ["centiliter", "centilitre"]],
    ["dl", 1e-1, "dL", "deciliters", ["deciliter", "decilitre"]],
    ["l", 1, "L", "liters", ["liter", "litre", "ltr", "lt"]],
    ["tsp", 0.00492892159375, "tsp", "teaspoons", ["teaspoon"]],
    ["tbsp", 0.01478676478125, "tbsp", "tablespoons", ["tablespoon", "tbs"]],
    ["floz", 0.0295735295625, "fl oz", "fluid ounces", ["fl oz", "fluid ounce", "fl. oz"]],
    ["cup", 0.2365882365, "cups", "cups", ["cup"]],
    ["pt", 0.473176473, "pt", "pints", ["pint"]],
    ["qt", 0.946352946, "qt", "quarts", ["quart"]],
    ["gal", 3.785411784, "gal", "gallons", ["gallon", "us gallon", "us gal"]],
    ["impgal", 4.54609, "imp gal", "imperial gallons", ["imperial gallon", "imp gal", "uk gallon", "uk gal"]],
  ],
  temperature: [
    ["c", 1, "°C", "Celsius", ["celsius", "centigrade", "degc", "°c"], 273.15],
    ["f", 5 / 9, "°F", "Fahrenheit", ["fahrenheit", "degf", "°f"], 459.67],
    ["k", 1, "K", "Kelvin", ["kelvin", "kelvins"], 0],
  ],
  area: [
    ["ha", 1e4, "ha", "hectares", ["hectare"]],
    ["acre", 4046.8564224, "ac", "acres", ["ac", "acres"]],
  ],
  speed: [
    ["kn", 1852 / 3600, "kn", "knots", ["kt", "kts", "knot"]],
    ["mph", 1609.344 / 3600, "mph", "miles per hour", ["mph"]],
    ["kmh", 1000 / 3600, "km/h", "kilometers per hour", ["kph", "kmh", "kmph", "kph"]],
    ["mps", 1, "m/s", "meters per second", ["mps"]],
    ["fps", 0.3048, "ft/s", "feet per second", ["fps"]],
    ["mach", 343, "Mach", "Mach", ["mach"]],
  ],
  data: [
    ["bit", 1 / 8, "bit", "bits", ["bits"]],
    ["B", 1, "B", "bytes", ["b", "byte", "bytes"]],
    ["kB", 1e3, "kB", "kilobytes", ["kb", "kilobyte"]],
    ["MB", 1e6, "MB", "megabytes", ["mb", "megabyte"]],
    ["GB", 1e9, "GB", "gigabytes", ["gb", "gigabyte", "gig", "gigs"]],
    ["TB", 1e12, "TB", "terabytes", ["tb", "terabyte"]],
    ["PB", 1e15, "PB", "petabytes", ["pb", "petabyte"]],
    ["KiB", 1024, "KiB", "kibibytes", ["kib", "kibibyte"]],
    ["MiB", 1024 ** 2, "MiB", "mebibytes", ["mib", "mebibyte"]],
    ["GiB", 1024 ** 3, "GiB", "gibibytes", ["gib", "gibibyte"]],
    ["TiB", 1024 ** 4, "TiB", "tebibytes", ["tib", "tebibyte"]],
    ["kbit", 1e3 / 8, "kbit", "kilobits", ["kbit", "kilobit", "kbps"]],
    ["Mbit", 1e6 / 8, "Mbit", "megabits", ["mbit", "megabit", "mbps"]],
    ["Gbit", 1e9 / 8, "Gbit", "gigabits", ["gbit", "gigabit", "gbps"]],
    ["Tbit", 1e12 / 8, "Tbit", "terabits", ["tbit", "terabit"]],
  ],
  time: [
    ["ns", 1e-9, "ns", "nanoseconds", ["nanosecond"]],
    ["us", 1e-6, "µs", "microseconds", ["µs", "microsecond"]],
    ["ms", 1e-3, "ms", "milliseconds", ["millisecond", "msec", "msecs"]],
    ["s", 1, "s", "seconds", ["sec", "secs", "second"]],
    ["min", 60, "min", "minutes", ["mins", "minute"]],
    ["h", 3600, "h", "hours", ["hr", "hrs", "hour"]],
    ["d", 86_400, "d", "days", ["day"]],
    ["wk", 604_800, "wk", "weeks", ["w", "wks", "week"]],
    ["mo", 2_629_746, "mo", "months", ["month", "mos"]],
    ["yr", 31_556_952, "yr", "years", ["y", "yrs", "year"]],
    ["decade", 315_569_520, "decades", "decades", ["decade"]],
    ["century", 3_155_695_200, "centuries", "centuries", ["century", "centuries"]],
  ],
};

const BY_ALIAS = new Map<string, UnitDef>();
const BY_ID = new Map<string, UnitDef>();
for (const [dim, specs] of Object.entries(SPECS) as Array<[Dimension, Spec[]]>) {
  for (const [id, factor, symbol, name, aliases, offset] of specs) {
    const def: UnitDef = { id: `${dim}:${id}`, dim, factor, symbol, name, offset };
    BY_ID.set(def.id, def);
    for (const a of [id.toLowerCase(), symbol.toLowerCase(), name.toLowerCase(), ...aliases.map((x) => x.toLowerCase())]) {
      if (!BY_ALIAS.has(a)) BY_ALIAS.set(a, def);
    }
  }
}

const LENGTH_UNITS = new Set(SPECS.length.map((s) => s[0]));

function plainLookup(token: string): UnitDef | undefined {
  const hit = BY_ALIAS.get(token);
  if (hit) return hit;
  if (token.endsWith("es") && BY_ALIAS.has(token.slice(0, -2))) return BY_ALIAS.get(token.slice(0, -2));
  if (token.endsWith("s") && token.length > 2) return BY_ALIAS.get(token.slice(0, -1));
  return undefined;
}

/** "sq ft", "square meters", "km2", "m²" → area; "cubic feet", "cm3" → volume. */
function poweredLength(token: string): UnitDef | undefined {
  let power = 0;
  let rest = token;
  const pre = /^(sq|square|cu|cubic)\s+(.+)$/.exec(rest);
  if (pre) {
    power = pre[1]!.startsWith("s") ? 2 : 3;
    rest = pre[2]!;
  } else {
    const post = /^(.+?)\s*(?:\^?([23])|([²³]))$/.exec(rest);
    if (!post) return undefined;
    power = post[2] ? Number(post[2]) : post[3] === "²" ? 2 : 3;
    rest = post[1]!;
  }
  const len = plainLookup(rest);
  if (!len || len.dim !== "length" || !LENGTH_UNITS.has(len.id.slice("length:".length))) return undefined;
  const sym = `${len.symbol}${power === 2 ? "²" : "³"}`;
  if (power === 2) return { id: `area:${len.symbol}2`, dim: "area", factor: len.factor ** 2, symbol: sym, name: `square ${len.name}` };
  // Volume base is the liter (1 m³ = 1000 L).
  return { id: `volume:${len.symbol}3`, dim: "volume", factor: len.factor ** 3 * 1000, symbol: sym, name: `cubic ${len.name}` };
}

/** "km/h", "miles per hour", "ft/s" → speed. */
function compoundSpeed(token: string): UnitDef | undefined {
  const m = /^(.+?)\s*(?:\/|\bper\b|\bp\b)\s*(.+)$/.exec(token);
  if (!m) return undefined;
  const a = lookupUnit(m[1]!);
  const b = lookupUnit(m[2]!);
  if (a?.dim !== "length" || b?.dim !== "time") return undefined;
  return { id: `speed:${a.symbol}/${b.symbol}`, dim: "speed", factor: a.factor / b.factor, symbol: `${a.symbol}/${b.symbol}`, name: `${a.name} per ${b.name.replace(/s$/, "")}` };
}

/** Resolve a unit name typed by the user ("Miles", "°F", "Mb", "sq ft"). */
export function lookupUnit(raw: string): UnitDef | undefined {
  const trimmed = raw.trim().replace(/\.$/, "");
  if (!trimmed) return undefined;
  // "Mb"/"Gb" (capital prefix, lowercase b) is the networking spelling for bits.
  const bits = /^([kKMGTP])b$/.exec(trimmed);
  if (bits && trimmed[0] !== "k") {
    const bit = BY_ID.get(trimmed === "Kb" ? "data:kbit" : `data:${bits[1]!.toUpperCase()}bit`);
    if (bit) return bit;
  }
  const token = trimmed
    .toLowerCase()
    .replace(/^degrees?\s+/, "")
    .replace(/^°\s*/, "")
    .replace(/\s+/g, " ");
  return plainLookup(token) ?? poweredLength(token) ?? compoundSpeed(token) ?? (token === "m/s" ? BY_ID.get("speed:mps") : undefined);
}

export function toBase(value: number, u: UnitDef): number {
  return (value + (u.offset ?? 0)) * u.factor;
}

export function fromBase(base: number, u: UnitDef): number {
  return base / u.factor - (u.offset ?? 0);
}

export function convertValue(value: number, from: UnitDef, to: UnitDef): number {
  if (from.dim !== to.dim) throw new Error(`Cannot convert ${from.dim} to ${to.dim}`);
  return fromBase(toBase(value, from), to);
}

export interface UnitConversion {
  dim: Dimension;
  /** Source terms, e.g. [{5, ft}, {10, in}] for "5 ft 10 in". */
  from: Array<{ amount: number; unit: UnitDef }>;
  to: UnitDef;
  value: number;
}

// The lookahead leaves the following space unconsumed so "5 in in cm" finds the second "in".
const SEPARATOR = /\s+(?:in|to|into|as)(?=\s)|\s*(?:=|->|→|>)\s*/i;

/** Split "<source> in <target>" at the last separator (so "5 in in cm" works). */
function splitQuery(q: string): [string, string] | undefined {
  const re = new RegExp(SEPARATOR.source, "gi");
  let last: RegExpExecArray | undefined;
  for (let m = re.exec(q); m; m = re.exec(q)) last = m;
  if (!last) return undefined;
  return [q.slice(0, last.index).trim(), q.slice(last.index + last[0].length).trim()];
}

/** "5 ft 10 in" → [[5, "ft"], [10, "in"]]; "100f" → [[100, "f"]]. */
function sourceTerms(src: string): Array<[number, string]> | undefined {
  const re = /([-+]?(?:\d[\d,_]*\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([^\d\s][^\d]*?)\s*(?=[-+]?\d|\.\d|$)/giy;
  const out: Array<[number, string]> = [];
  let pos = 0;
  const s = src.trim();
  re.lastIndex = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m[0].length === 0) return undefined;
    const amount = parseAmount(m[1]!);
    if (amount === undefined) return undefined;
    out.push([amount, m[2]!.trim()]);
    pos = re.lastIndex;
    while (s[pos] === " ") pos++;
  }
  return out.length ? out : undefined;
}

/** Parse and evaluate a unit conversion query; undefined when the text is not one. */
export function parseUnitConversion(query: string): UnitConversion | undefined {
  const q = query.trim();
  if (!/\d/.test(q)) return undefined;
  const parts = splitQuery(q);
  if (!parts) return undefined;
  const [src, dst] = parts;
  const to = lookupUnit(dst);
  if (!to) return undefined;
  const terms = sourceTerms(src);
  if (!terms) return undefined;
  const from: UnitConversion["from"] = [];
  for (const [amount, name] of terms) {
    const unit = lookupUnit(name);
    if (!unit || unit.dim !== to.dim) return undefined;
    from.push({ amount, unit });
  }
  // Compound sources only make sense for additive units (not "5 c 3 f").
  if (from.length > 1 && to.dim === "temperature") return undefined;
  const base = from.reduce((sum, t) => sum + toBase(t.amount, t.unit), 0);
  return { dim: to.dim, from, to, value: fromBase(base, to) };
}
