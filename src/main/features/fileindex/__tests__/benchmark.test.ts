import { describe, expect, it } from "vitest";
import { IndexBuilder } from "../db";
import { deserialize, serialize } from "../persist";
import { parseQuery, search } from "../query";

/** Shared CI runners are slower; CI sets GLIDE_PERF_THRESHOLD_SCALE (default 1). */
const SCALE = Number(process.env.GLIDE_PERF_THRESHOLD_SCALE ?? 1);

const WORDS = "report invoice notes draft final project plan budget photo holiday meeting summary design spec readme config index main test utils server client data image video audio backup archive letter resume taxes contract slides demo build release alpha beta gamma delta".split(" ");
const EXTS = "pdf txt md ts tsx js json png jpg mov mp3 docx xlsx key swift py rs go html css".split(" ");

/** Deterministic synthetic tree of ~150k entries. */
function synthetic(total: number) {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const now = Date.now();
  const b = new IndexBuilder();
  const root = b.insert("/Users/bench", -1, { isDir: true, size: 0, mtime: now, atime: 0 });
  const dirs = [root];
  while (b.count < total) {
    const parent = dirs[Math.floor(rand() * Math.min(dirs.length, 4000))];
    if (rand() < 0.12) {
      dirs.push(b.insert(`${pick(WORDS)}-${pick(WORDS)}`, parent, { isDir: true, size: 0, mtime: now - rand() * 9e10, atime: 0 }));
    } else {
      const name = `${pick(WORDS)}${rand() < 0.5 ? "_" : " "}${pick(WORDS)}${Math.floor(rand() * 1000)}.${pick(EXTS)}`;
      b.insert(name, parent, { isDir: false, size: Math.floor(rand() * 1e6), mtime: now - rand() * 9e10, atime: 0 });
    }
  }
  return b.finish(1, now);
}

describe("benchmark (150k synthetic entries)", () => {
  const db = synthetic(150_000);

  it("answers queries in < 30 ms (top 20)", () => {
    const queries = ["r", "rep", "report", "report final", "invoice 2", "budget kind:pdf", "holiday photo", "summ", "readme in:/Users/bench", "zzz", "plan", "tst", "alpha beta"];
    for (const text of queries) search(db, parseQuery(text, "/Users/bench")); // warm-up (JIT)
    const timings: Record<string, number> = {};
    for (const text of queries) {
      const runs = 5;
      const t0 = performance.now();
      let hits = 0;
      for (let i = 0; i < runs; i++) hits = search(db, parseQuery(text, "/Users/bench"), { limit: 20 }).length;
      timings[text] = (performance.now() - t0) / runs;
      if (text !== "zzz") expect(hits).toBeGreaterThan(0);
    }
    console.log("[fileindex bench] ms per query:", Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Number(v.toFixed(2))])));
    for (const [text, ms] of Object.entries(timings)) expect(ms, text).toBeLessThan(30 * SCALE);
  });

  it("loads a persisted 150k index in < 300 ms", () => {
    const bytes = serialize(db);
    const t0 = performance.now();
    const back = deserialize(bytes);
    const ms = performance.now() - t0;
    console.log(`[fileindex bench] ${(bytes.length / 1e6).toFixed(1)} MB index, load ${ms.toFixed(1)} ms`);
    expect(back.count).toBe(db.count);
    expect(ms).toBeLessThan(300 * SCALE);
  });
});
