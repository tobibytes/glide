/**
 * File-name tokenizer:
 * split on separators and camelCase / letter↔digit edges, lowercase and fold
 * diacritics (café → cafe), CJK ideographs become one token each.
 */
import { foldText } from "@engine/fuzzy";

const isUpperCode = (c: number) => c >= 65 && c <= 90;
const isLowerCode = (c: number) => c >= 97 && c <= 122;
const isDigitCode = (c: number) => c >= 48 && c <= 57;
// CJK Unified Ideographs, Hiragana/Katakana, Hangul syllables.
const isCjk = (c: number) => (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff);
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordCode(c: number, ch: string): boolean {
  if (c < 128) return isLowerCode(c) || isUpperCode(c) || isDigitCode(c);
  return WORD_CHAR.test(ch);
}

/** Split raw (unfolded) text into words, respecting camelCase and letter/digit edges. */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end > start) words.push(text.slice(start, end));
    start = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ch = text.charAt(i);
    if (!isWordCode(c, ch)) {
      flush(i);
      continue;
    }
    if (isCjk(c)) {
      flush(i);
      words.push(ch);
      continue;
    }
    if (start < 0) {
      start = i;
      continue;
    }
    const p = text.charCodeAt(i - 1);
    const n = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const camel = (isLowerCode(p) && isUpperCode(c)) || (isUpperCode(p) && isUpperCode(c) && isLowerCode(n)); // fooBar | XMLParser
    const digitEdge = isDigitCode(p) !== isDigitCode(c) && p < 128 && c < 128;
    if (camel || digitEdge) {
      flush(i);
      start = i;
    }
  }
  flush(text.length);
  return words;
}

/**
 * Index tokens for a file name: folded words, plus the whole name with
 * separators removed (so "myrep" finds "my-report.pdf"). Deduplicated.
 */
export function nameTokens(name: string): string[] {
  const words = splitWords(name).map(foldText);
  const out = new Set(words);
  if (words.length > 1) out.add(words.join(""));
  out.delete("");
  return [...out];
}

/** Query words: same splitting so "fooBar" / "foo-bar" / "foo bar" all behave alike. */
export function queryTokens(text: string): string[] {
  const out: string[] = [];
  for (const w of splitWords(text)) {
    const f = foldText(w);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}
