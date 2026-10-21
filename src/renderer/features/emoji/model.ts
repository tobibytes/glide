/** Emoji dataset access, search and skin tones. Pure: shared by the picker view and the main-process ":name" items. */
import { EMOJI_ROWS } from "./data";

export interface Emoji {
  char: string;
  name: string;
  keywords: string[];
  category: number;
  /** "" no skin tones; "1" modifier after the first code point; otherwise the light-tone form as a template. */
  skin: string;
}

export const CATEGORIES = [
  { id: "smileys", title: "Smileys & Emotion", icon: "😀" },
  { id: "people", title: "People & Body", icon: "👋" },
  { id: "nature", title: "Animals & Nature", icon: "🐻" },
  { id: "food", title: "Food & Drink", icon: "🍔" },
  { id: "travel", title: "Travel & Places", icon: "✈️" },
  { id: "activities", title: "Activities", icon: "⚽" },
  { id: "objects", title: "Objects", icon: "💡" },
  { id: "symbols", title: "Symbols", icon: "❤️" },
  { id: "flags", title: "Flags", icon: "🏁" },
] as const;

export const SKIN_TONES = [
  { label: "Default", swatch: "✋", modifier: "" },
  { label: "Light", swatch: "✋🏻", modifier: "\u{1F3FB}" },
  { label: "Medium-Light", swatch: "✋🏼", modifier: "\u{1F3FC}" },
  { label: "Medium", swatch: "✋🏽", modifier: "\u{1F3FD}" },
  { label: "Medium-Dark", swatch: "✋🏾", modifier: "\u{1F3FE}" },
  { label: "Dark", swatch: "✋🏿", modifier: "\u{1F3FF}" },
] as const;

let cache: Emoji[] | null = null;
let byChar: Map<string, Emoji> | null = null;

export function parseRows(rows: string): Emoji[] {
  return rows.split("\n").flatMap((line) => {
    const [char, name, kw, cat, skin] = line.split("|");
    if (!char || !name) return [];
    return [{ char, name, keywords: kw ? kw.split(" ") : [], category: Number(cat) || 0, skin: skin ?? "" }];
  });
}

export function allEmoji(): Emoji[] {
  if (!cache) {
    cache = parseRows(EMOJI_ROWS);
    byChar = new Map(cache.map((e) => [e.char, e]));
  }
  return cache;
}

export function findEmoji(char: string): Emoji | undefined {
  allEmoji();
  return byChar?.get(char);
}

/** Apply a skin tone (0 = default … 5 = dark) where the emoji supports one. */
export function withTone(e: Emoji, tone: number): string {
  const mod = SKIN_TONES[tone]?.modifier ?? "";
  if (!mod || !e.skin) return e.char;
  if (e.skin === "1") {
    const cps = [...e.char];
    const rest = cps.slice(1);
    if (rest[0] === "️") rest.shift();
    return cps[0] + mod + rest.join("");
  }
  return e.skin.replace(/\u{1F3FB}/gu, mod);
}

function tokenScore(e: Emoji, token: string, nameWords: string[]): number {
  if (e.name === token) return 100;
  if (e.name.startsWith(token)) return 80;
  if (nameWords.some((w) => w === token)) return 70;
  if (nameWords.some((w) => w.startsWith(token))) return 60;
  if (e.keywords.some((k) => k === token)) return 50;
  if (e.keywords.some((k) => k.startsWith(token))) return 40;
  if (e.name.includes(token)) return 20;
  return 0;
}

/** Every token must match the name or a keyword; better matches first, dataset order breaks ties. */
export function searchEmoji(query: string, list: Emoji[] = allEmoji(), limit = Infinity): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:/, "").replace(/:$/, "");
  if (!q) return list.slice(0, limit);
  const tokens = q.split(/[\s_]+/).filter(Boolean);
  const scored: Array<{ e: Emoji; s: number; i: number }> = [];
  list.forEach((e, i) => {
    if (e.char === q) {
      scored.push({ e, s: 1000, i });
      return;
    }
    const words = e.name.split(/[^a-z0-9]+/);
    let total = 0;
    for (const t of tokens) {
      const s = tokenScore(e, t, words);
      if (!s) return;
      total += s;
    }
    if (tokens.length > 1) total += e.name === q ? 200 : e.name.startsWith(q) ? 50 : 0;
    scored.push({ e, s: total, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}

export interface UsageEntry {
  count: number;
  last: number;
}

/** Recently used (by time) and frequently used (by count, excluding the recent ones). */
export function usageSections(usage: Record<string, UsageEntry>, recentN = 8, frequentN = 16): { recent: string[]; frequent: string[] } {
  const entries = Object.entries(usage);
  const recent = entries.sort((a, b) => b[1].last - a[1].last).slice(0, recentN).map(([c]) => c);
  const frequent = Object.entries(usage)
    .filter(([c, u]) => !recent.includes(c) && u.count > 1)
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, frequentN)
    .map(([c]) => c);
  return { recent, frequent };
}
