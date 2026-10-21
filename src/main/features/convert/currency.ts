/**
 * Currency conversion: "100 usd in eur", "€50 to gbp", "50 euros in naira", "$20".
 * Parsing and maths are pure; fetching/caching rates lives in ./rates.ts.
 */
import { parseAmount } from "./format";

/** Names people type, mapped to ISO 4217 codes. Codes themselves are always accepted when the rate table has them. */
const NAMES: Record<string, string> = {
  dollar: "USD", dollars: "USD", buck: "USD", bucks: "USD", "us dollar": "USD", "us dollars": "USD",
  euro: "EUR", euros: "EUR",
  pound: "GBP", pounds: "GBP", quid: "GBP", sterling: "GBP", "british pound": "GBP", "british pounds": "GBP",
  yen: "JPY", yuan: "CNY", renminbi: "CNY", rmb: "CNY",
  rupee: "INR", rupees: "INR", naira: "NGN", cedi: "GHS", cedis: "GHS", rand: "ZAR", shilling: "KES", shillings: "KES",
  franc: "CHF", francs: "CHF", "swiss franc": "CHF", "swiss francs": "CHF",
  won: "KRW", peso: "MXN", pesos: "MXN", real: "BRL", reais: "BRL", ruble: "RUB", rubles: "RUB", rouble: "RUB", roubles: "RUB",
  lira: "TRY", krona: "SEK", kronor: "SEK", krone: "NOK", kroner: "NOK", zloty: "PLN", forint: "HUF", baht: "THB",
  dirham: "AED", dirhams: "AED", riyal: "SAR", riyals: "SAR", ringgit: "MYR", rupiah: "IDR", dong: "VND", shekel: "ILS", shekels: "ILS",
  "canadian dollar": "CAD", "canadian dollars": "CAD", "australian dollar": "AUD", "australian dollars": "AUD",
  "hong kong dollar": "HKD", "singapore dollar": "SGD", "new zealand dollar": "NZD",
};

/** Currency symbols; "$" means USD unless prefixed (C$, A$, …). */
const SYMBOLS: Array<[string, string]> = [
  ["US$", "USD"], ["C$", "CAD"], ["CA$", "CAD"], ["A$", "AUD"], ["AU$", "AUD"], ["NZ$", "NZD"], ["HK$", "HKD"], ["S$", "SGD"], ["R$", "BRL"], ["MX$", "MXN"],
  ["$", "USD"], ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₹", "INR"], ["₩", "KRW"], ["₽", "RUB"], ["₺", "TRY"], ["₦", "NGN"], ["₱", "PHP"],
  ["₫", "VND"], ["₪", "ILS"], ["฿", "THB"], ["₴", "UAH"], ["₵", "GHS"], ["zł", "PLN"], ["kr", "SEK"], ["Fr", "CHF"],
];

const SYMBOL_OF: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", KRW: "₩", NGN: "₦", RUB: "₽", TRY: "₺", PHP: "₱", ILS: "₪", THB: "฿", UAH: "₴", GHS: "₵", VND: "₫" };

/** ISO 4217 codes in circulation (used before any rate table is cached, so "100 abc" never triggers a fetch). */
export const ISO_CODES = new Set(
  ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK " +
    "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF " +
    "KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP " +
    "PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU " +
    "UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL").split(" "),
);

/** Currencies with no minor unit in everyday use. */
const ZERO_DECIMALS = new Set(["JPY", "KRW", "VND", "IDR", "CLP", "HUF", "ISK", "UGX"]);

export interface RateTable {
  /** Rates relative to `base`: 1 base = rates[code] code. */
  base: string;
  rates: Record<string, number>;
  /** Date the provider published the rates (YYYY-MM-DD). */
  date: string;
  /** When Glide fetched them (unix ms). */
  fetchedAt: number;
  source: string;
}

/** "usd", "Euros", "€", "C$" → ISO code; `known` limits bare 3-letter codes to real ones. */
export function lookupCurrency(raw: string, known?: (code: string) => boolean): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  for (const [sym, code] of SYMBOLS) if (t === sym) return code;
  const lower = t.toLowerCase().replace(/\s+/g, " ");
  if (NAMES[lower]) return NAMES[lower];
  if (/^[a-z]{3}$/i.test(t)) {
    const code = t.toUpperCase();
    if (!known || known(code)) return code;
  }
  return undefined;
}

export interface CurrencyQuery {
  amount: number;
  from: string;
  /** undefined: convert to the user's default currency */
  to?: string;
}

const SEP = /\s+(?:in|to|into|as)\s+|\s*(?:=|->|→)\s*/i;
const symbolPattern = SYMBOLS.map(([s]) => s.replace(/[$]/g, "\\$")).join("|");
const AMOUNT = String.raw`[-+]?(?:\d[\d,_]*\.?\d*|\.\d+)(?:\s*[kmb]\b)?`;
const PREFIX_SYM = new RegExp(String.raw`^(${symbolPattern})\s*(${AMOUNT})$`, "i");
const SUFFIX_UNIT = new RegExp(String.raw`^(${AMOUNT})\s*(.+)$`, "i");

function parseSource(src: string, known: (code: string) => boolean): { amount: number; from: string } | undefined {
  const s = src.trim();
  const pre = PREFIX_SYM.exec(s);
  if (pre) {
    const from = lookupCurrency(pre[1]!, known);
    const amount = parseAmount(pre[2]!.replace(/\s+/g, ""), true);
    return from && amount !== undefined ? { amount, from } : undefined;
  }
  const suf = SUFFIX_UNIT.exec(s);
  if (suf) {
    const from = lookupCurrency(suf[2]!, known);
    const amount = parseAmount(suf[1]!.replace(/\s+/g, ""), true);
    return from && amount !== undefined ? { amount, from } : undefined;
  }
  return undefined;
}

/**
 * Parse a currency query. Without a target ("$20", "50 eur") the caller converts to the default currency.
 * `known` should test codes against the rate table so "100 abc" is not treated as money.
 */
export function parseCurrencyQuery(query: string, known: (code: string) => boolean = (c) => ISO_CODES.has(c)): CurrencyQuery | undefined {
  const q = query.trim();
  if (!/\d/.test(q) || q.length > 60) return undefined;
  const m = SEP.exec(q);
  if (m) {
    const src = parseSource(q.slice(0, m.index), known);
    const to = lookupCurrency(q.slice(m.index + m[0].length), known);
    return src && to ? { ...src, to } : undefined;
  }
  return parseSource(q, known);
}

/** True for text that could become a currency query, used to decide whether to fetch rates at all. */
export function looksLikeCurrency(query: string): boolean {
  return parseCurrencyQuery(query) !== undefined;
}

export function convertCurrency(amount: number, from: string, to: string, table: RateTable): number | undefined {
  const rate = (code: string) => (code === table.base ? 1 : table.rates[code]);
  const a = rate(from);
  const b = rate(to);
  if (!a || !b) return undefined;
  return (amount / a) * b;
}

export function currencyDecimals(code: string): number {
  return ZERO_DECIMALS.has(code) ? 0 : 2;
}

/** "€1,234.50" / "1,234.50 SEK" for display. */
export function formatMoney(value: number, code: string): string {
  const decimals = Math.abs(value) < 1 && value !== 0 ? 4 : currencyDecimals(code);
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const num = `${value < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  const sym = SYMBOL_OF[code];
  return sym ? `${sym}${num}` : `${num} ${code}`;
}

/** Plain number for copying ("1234.50"). */
export function plainMoney(value: number, code: string): string {
  const decimals = Math.abs(value) < 1 && value !== 0 ? 4 : currencyDecimals(code);
  return value.toFixed(decimals);
}
