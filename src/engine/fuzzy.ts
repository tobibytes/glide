/**
 * Glide's root-search subsequence scorer (`fuzzyMatch`) and its helpers: word
 * boundaries, per-char bonus, sensitivity gate, exact/prefix test and the
 * whole-word floor.
 *
 * Pure TypeScript, no platform APIs.
 */
import type { MatchRange } from "@shared/types";

export type Sensitivity = "low" | "medium" | "high";

/** Score of an exact (whole-text) match: 2^53-1. */
export const EXACT_SCORE = Number.MAX_SAFE_INTEGER;
/** Score for an unmatched field: -(2^53-1). */
export const UNMATCHED_SCORE = -Number.MAX_SAFE_INTEGER;

export interface FuzzyResult {
  /** DP score (EXACT_SCORE when the whole text equals the query). */
  score: number;
  exact: boolean;
  /** `text.length > query.length && text.startsWith(query)`. */
  prefix: boolean;
  /** Query separator characters that found no counterpart in the text. */
  skipped: number;
  /** Matched character ranges in the ORIGINAL text, adjacent ones merged. */
  ranges: MatchRange[];
}

export interface FuzzyOptions {
  /**
   * When true (used for every root-search field) a "." in the query is a literal character, not a skippable separator.
   */
  literalQueryDots?: boolean;
}

/** Pre-folded text with per-position bonus information, built once per item. */
export interface PreparedText {
  readonly text: string;
  /** Lowercased, diacritic-folded; same length as `text` (index-preserving). */
  readonly folded: string;
  /** UTF-16 code units of `folded`. */
  readonly codes: Uint16Array;
  /** 1 when the folded char is a separator (separator table). */
  readonly isSep: Uint8Array;
  /** Per-char bonus: 3 at a word boundary, 2 elsewhere. */
  readonly bonus: Uint8Array;
}

export interface PreparedQuery {
  readonly text: string;
  readonly folded: string;
  readonly codes: Uint16Array;
  /** 1 when the char is a skippable separator (after the literalQueryDots rule). */
  readonly isSkippable: Uint8Array;
  /** number of non-skippable chars */
  readonly required: number;
  readonly literalQueryDots: boolean;
}

// ---------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------

/** Separator byte table: '\t',' ',' ' (nbsp),'-','.','/','(',')','[',']' (ASCII/latin-1 only). */
const SEPARATORS = new Uint8Array(256);
for (const ch of "\t  -./()[]") SEPARATORS[ch.charCodeAt(0)] = 1;
const DOT = 46;

export function isSeparatorCode(code: number): boolean {
  return code < 256 && SEPARATORS[code] === 1;
}

const COMBINING = /[̀-ͯ]/g;
const foldCache = new Map<string, string>();

/** Fold one UTF-16 unit: NFD, strip combining marks, lowercase; always 1 unit long. */
function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  let out = foldCache.get(ch);
  if (out === undefined) {
    const base = ch.normalize("NFD").replace(COMBINING, "");
    const lower = (base.length ? base : ch).toLowerCase();
    out = lower.length === 1 ? lower : lower.charAt(0) || ch;
    if (out.length !== 1) out = ch;
    foldCache.set(ch, out);
  }
  return out;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Lowercase + diacritic fold while preserving string length so that match
 * positions map 1:1 onto the original text (NFD + strip combining marks).
 */
export function foldText(text: string): string {
  if (ASCII_ONLY.test(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldChar(text.charAt(i));
  return out;
}

const isLowerOrDigit = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
const isUpper = (c: number): boolean => c >= 65 && c <= 90;

/**
 * Fold the text, compute camelCase word boundaries on the ORIGINAL case
 * (`[a-z0-9]` → `[A-Z]`) and the per-char bonus for every position.
 */
export function prepareText(text: string): PreparedText {
  const folded = foldText(text);
  const n = folded.length;
  const codes = new Uint16Array(n);
  const isSep = new Uint8Array(n);
  const bonus = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = folded.charCodeAt(i);
    codes[i] = c;
    isSep[i] = c < 256 ? SEPARATORS[c] : 0;
  }
  for (let i = 0; i < n; i++) {
    if (isSep[i]) {
      bonus[i] = 2;
      continue;
    }
    const camel = i > 0 && isLowerOrDigit(text.charCodeAt(i - 1)) && isUpper(text.charCodeAt(i));
    const afterSep = i > 0 && isSep[i - 1] === 1;
    bonus[i] = camel || afterSep ? 3 : 2;
  }
  return { text, folded, codes, isSep, bonus };
}

export function prepareQuery(query: string, opts?: FuzzyOptions): PreparedQuery {
  const literalQueryDots = opts?.literalQueryDots ?? true;
  const folded = foldText(query);
  const n = folded.length;
  const codes = new Uint16Array(n);
  const isSkippable = new Uint8Array(n);
  let required = 0;
  for (let i = 0; i < n; i++) {
    const c = folded.charCodeAt(i);
    codes[i] = c;
    const skippable = c < 256 && SEPARATORS[c] === 1 && !(literalQueryDots && c === DOT);
    isSkippable[i] = skippable ? 1 : 0;
    if (!skippable) required++;
  }
  return { text: query, folded, codes, isSkippable, required, literalQueryDots };
}

// ---------------------------------------------------------------------------
// DP scorer
// ---------------------------------------------------------------------------

// Reusable scratch buffers (grown on demand) so a search over thousands of
// items allocates nothing per call.
let prevRow = new Float64Array(64);
let currRow = new Float64Array(64);
let backPtr = new Int32Array(64 * 16); // [row * textLen + col] -> column in previous effective row
let rowCols = new Int32Array(64); // best column per effective row (for backtracking)

function ensureBuffers(textLen: number, queryLen: number): void {
  if (prevRow.length < textLen) {
    prevRow = new Float64Array(textLen * 2);
    currRow = new Float64Array(textLen * 2);
  }
  if (backPtr.length < textLen * queryLen) backPtr = new Int32Array(textLen * queryLen * 2);
  if (rowCols.length < queryLen) rowCols = new Int32Array(queryLen * 2);
}

/** Cheap ordered-subsequence precheck of the non-skippable query chars. */
function subsequencePrecheck(t: PreparedText, q: PreparedQuery): boolean {
  let pos = 0;
  const tc = t.codes;
  const n = tc.length;
  for (let i = 0; i < q.codes.length; i++) {
    if (q.isSkippable[i]) continue;
    const c = q.codes[i];
    while (pos < n && tc[pos] !== c) pos++;
    if (pos >= n) return false;
    pos++;
  }
  return true;
}

function mergeRanges(cols: number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const c of cols) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === c) last.end = c + 1;
    else ranges.push({ start: c, end: c + 1 });
  }
  return ranges;
}

const NEG = UNMATCHED_SCORE;

/**
 * Ordered-subsequence DP.
 *  - 4 for a match on the very first text char (first query char only),
 *  - 3 at a word boundary (prev char separator or camelCase edge, char itself not a separator),
 *  - 2 elsewhere,
 *  - 1 when a skippable query separator matches a *different* text separator,
 *  - consecutive matches carry no penalty, any gap costs 1,
 *  - skippable query separators without a counterpart are skipped (counted),
 *  - any other unmatched query char ⇒ null (unmatched).
 * Whole-text equality ⇒ exact (score EXACT_SCORE).
 */
export function fuzzyMatch(
  text: string | PreparedText,
  query: string | PreparedQuery,
  opts?: FuzzyOptions,
): FuzzyResult | null {
  const t = typeof text === "string" ? prepareText(text) : text;
  const q = typeof query === "string" ? prepareQuery(query, opts) : query;
  const s = t.codes.length;
  const c = q.codes.length;

  if (c === 0) return null;
  if (t.folded === q.folded) {
    return { score: EXACT_SCORE, exact: true, prefix: false, skipped: 0, ranges: s ? [{ start: 0, end: s }] : [] };
  }
  const prefix = s > c && t.folded.startsWith(q.folded);
  const u = q.required;
  if (u > s) return null;
  if (u > 2 && !subsequencePrecheck(t, q)) return null;

  ensureBuffers(s, c);
  const tc = t.codes;
  const tSep = t.isSep;
  const tBonus = t.bonus;

  let d = -1; // first matched column of the previous effective row
  let skipped = 0;
  let matchedRows = 0; // p
  let effRows = 0; // number of effective (matched) rows so far
  let prev = prevRow;
  let curr = currRow;

  for (let e = 0; e < c; e++) {
    const qc = q.codes[e];
    const skippable = q.isSkippable[e] === 1;
    const remaining = u - 1 - matchedRows; // l
    let m = -1;
    const h = d + 1;
    let g = s - remaining;
    if (g > s) g = s;
    const rowBase = effRows * s;

    // running max of prev[d .. e-2] for the "gap" transition
    let gapMax = NEG;
    let gapCol = -1;

    for (let col = h; col < g; col++) {
      // maintain running max over prev[d .. col-2]
      if (d >= 0 && col - 2 >= d) {
        const v = prev[col - 2];
        if (v > gapMax) {
          gapMax = v;
          gapCol = col - 2;
        }
      }
      const a = tc[col];
      const same = a === qc;
      const sepMatch = !same && skippable && tSep[col] === 1;
      if (!same && !sepMatch) {
        curr[col] = NEG;
        continue;
      }
      let score: number;
      let from = -1;
      if (d < 0) {
        score = sepMatch ? 1 : col === 0 ? 4 : tBonus[col];
      } else {
        const bonus = sepMatch ? 1 : tBonus[col];
        score = NEG;
        // consecutive transition from prev[col-1] (no penalty)
        if (col - 1 >= d) {
          const v = prev[col - 1];
          if (v > NEG) {
            score = v + bonus;
            from = col - 1;
          }
        }
        // gap transition (−1)
        if (gapMax > NEG) {
          const v = gapMax + bonus - 1;
          if (v > score) {
            score = v;
            from = gapCol;
          }
        }
        if (score <= NEG) {
          curr[col] = NEG;
          continue;
        }
      }
      curr[col] = score;
      backPtr[rowBase + col] = from;
      if (m < 0) m = col;
    }

    if (m >= 0) {
      // fill the untouched head/tail of the row so stale values never leak
      for (let col = 0; col < h; col++) curr[col] = NEG;
      for (let col = g; col < s; col++) curr[col] = NEG;
      d = m;
      matchedRows++;
      rowCols[effRows] = e;
      effRows++;
      const tmp = prev;
      prev = curr;
      curr = tmp;
    } else if (skippable) {
      skipped++;
      // row ignored: `prev` stays the previous effective row
    } else {
      return null;
    }
  }

  // best column of the last effective row
  let best = NEG;
  let bestCol = -1;
  for (let col = 0; col < s; col++) {
    if (prev[col] > best) {
      best = prev[col];
      bestCol = col;
    }
  }
  if (effRows === 0 || bestCol < 0) return null;

  // backtrack
  const cols: number[] = new Array(effRows);
  let col = bestCol;
  for (let r = effRows - 1; r >= 0; r--) {
    cols[r] = col;
    col = backPtr[r * s + col];
  }

  return { score: best, exact: false, prefix, skipped, ranges: mergeRanges(cols) };
}

// ---------------------------------------------------------------------------
// Companions
// ---------------------------------------------------------------------------

/** 'exact' | 'prefix' | 'unmatched' on folded strings. */
export function exactOrPrefix(text: string, query: string): "exact" | "prefix" | "unmatched" {
  if (text === query) return "exact";
  if (text.length > query.length && text.startsWith(query)) return "prefix";
  return "unmatched";
}

/**
 * Sensitivity gate:
 *   low    → any subsequence match
 *   medium → score >= 1.5 * (len − skipped − 2) + 4
 *   high   → score >  2   * (len − skipped)
 * `len` is the (transliterated) query length. An exact match always passes.
 */
export function passesSensitivity(score: number, len: number, skipped: number, level: Sensitivity): boolean {
  if (score === EXACT_SCORE) return true;
  if (score <= UNMATCHED_SCORE) return false;
  switch (level) {
    case "low":
      return true;
    case "medium":
      return score >= 1.5 * (len - skipped - 2) + 4;
    case "high":
    default:
      return score > 2 * (len - skipped);
  }
}

/** Whole-word floor: 4 + (len−1)·2 + 0.5 — just above a perfect run from position 0. */
export function wholeWordFloor(len: number): number {
  return 4 + (len - 1) * 2 + 0.5;
}

/**
 * Does the folded query occur as a whole word, bounded by separators /
 * camelCase boundaries / string ends? Applied only for queries of ≥3 chars with no whitespace (see `wholeWordApplies`).
 */
export function containsWholeWord(t: PreparedText, foldedQuery: string): boolean {
  const n = foldedQuery.length;
  if (n === 0) return false;
  let from = 0;
  for (;;) {
    const i = t.folded.indexOf(foldedQuery, from);
    if (i < 0) return false;
    const startOk = i === 0 || t.isSep[i - 1] === 1 || t.bonus[i] === 3;
    const end = i + n;
    const endOk = end === t.folded.length || t.isSep[end] === 1 || t.bonus[end] === 3;
    if (startOk && endOk) return true;
    from = i + 1;
  }
}

export function wholeWordApplies(query: string): boolean {
  return query.length >= 3 && !/\s/.test(query);
}
