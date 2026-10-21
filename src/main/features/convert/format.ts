/** Number formatting shared by every converter: compact, locale-independent, copy-friendly. */

/** Round to `sig` significant digits without float noise ("0.30000000000000004" → "0.3"). */
export function roundSig(n: number, sig = 6): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(sig));
}

/** "3106.86" style: no grouping (so the copy pastes into any app), up to `sig` significant digits. */
export function plainNumber(n: number, sig = 6): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : n < 0 ? "-∞" : "NaN";
  const r = roundSig(n, sig);
  const abs = Math.abs(r);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return r.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, "e");
  // toPrecision may leave exponent form for large integers; Number() + toString handles that range.
  return r.toString();
}

/** "1,234,567.89" for display. */
export function groupedNumber(n: number, sig = 6): string {
  const plain = plainNumber(n, sig);
  if (/e/i.test(plain) || !Number.isFinite(n)) return plain;
  const [int, frac] = plain.split(".");
  const neg = int!.startsWith("-");
  const digits = neg ? int!.slice(1) : int!;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Parse "1,000.5", "2e3" (and "1.5k" when allowSuffix); returns undefined when the text is not a plain number. */
export function parseAmount(text: string, allowSuffix = false): number | undefined {
  const s = text.trim().replace(/,(?=\d{3}\b)/g, "").replace(/_/g, "");
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([kmb])?$/i.exec(s);
  if (!m || (m[2] && !allowSuffix)) return undefined;
  const base = Number(m[1]);
  const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "k" | "m" | "b"] : 1;
  return Number.isFinite(base) ? base * mult : undefined;
}
