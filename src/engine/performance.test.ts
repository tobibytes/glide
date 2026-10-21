import { describe, expect, it } from "vitest";
import type { SearchItem, ItemKind } from "@shared/types";
import { createEngine } from "./index";

const WORDS = [
  "Visual", "Studio", "Code", "Safari", "Terminal", "Finder", "Notes", "Music", "Photos", "Mail", "Calendar",
  "Slack", "Discord", "Figma", "Sketch", "Xcode", "Preview", "Numbers", "Pages", "Keynote", "Activity", "Monitor",
  "Disk", "Utility", "Script", "Editor", "Console", "Automator", "Shortcuts", "System", "Settings", "Lock", "Screen",
  "Empty", "Trash", "Sleep", "Restart", "Search", "Google", "GitHub", "Pull", "Request", "Deploy", "Build", "Clipboard",
];
const KINDS: ItemKind[] = ["app", "system", "workflow", "quicklink", "snippet", "setting"];

function synthetic(n: number): SearchItem[] {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = () => WORDS[Math.floor(rnd() * WORDS.length)];
  const items: SearchItem[] = [];
  for (let i = 0; i < n; i++) {
    const words = 1 + Math.floor(rnd() * 3);
    const title = Array.from({ length: words }, pick).join(" ") + (rnd() < 0.3 ? ` ${i}` : "");
    const it: SearchItem = {
      id: `item-${i}`,
      kind: KINDS[i % KINDS.length],
      title,
      subtitle: rnd() < 0.6 ? `${pick()} ${pick()}` : undefined,
      keywords: rnd() < 0.5 ? [pick().toLowerCase(), pick().toLowerCase()] : undefined,
      alias: rnd() < 0.05 ? pick().slice(0, 2).toLowerCase() : undefined,
    };
    items.push(it);
  }
  return items;
}

const QUERIES = [
  "v", "vs", "vsc", "code", "saf", "safari", "term", "fin", "notes", "mus", "ph", "mail", "cal", "sl", "slack",
  "dis", "fig", "sk", "xc", "prev", "num", "pag", "key", "act", "am", "disk", "du", "scr", "ed", "con", "auto",
  "short", "sys", "set", "lock", "ls", "empty", "trash", "sleep", "rest", "search", "goo", "gh", "pr", "dep",
  "build", "clip", "visual studio", "google 42", "zzzz",
];

describe("performance", () => {
  it("2,000 items × 50 queries: average < 5 ms (fails above 20 ms)", () => {
    const engine = createEngine({ now: () => Date.now() });
    engine.setItems(synthetic(2000));
    engine.setUsage(
      Array.from({ length: 200 }, (_, i) => ({
        itemId: `item-${i * 7}`,
        launches: [Date.now() - i * 3_600_000],
        count: 1 + (i % 5),
        lastLaunchedAt: Date.now() - i * 3_600_000,
      })),
    );
    // warm-up
    for (const q of QUERIES.slice(0, 5)) engine.search(q);

    const t0 = performance.now();
    let total = 0;
    for (const q of QUERIES) total += engine.search(q).total;
    const avg = (performance.now() - t0) / QUERIES.length;
    expect(total).toBeGreaterThan(0);
    if (avg >= 5) console.warn(`[engine perf] average query time ${avg.toFixed(2)} ms (soft target < 5 ms)`);
    else console.log(`[engine perf] average query time ${avg.toFixed(2)} ms`);
    expect(avg).toBeLessThan(20);
  });
});
