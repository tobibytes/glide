import { describe, expect, it } from "vitest";
import type { UsageRecord } from "@shared/types";
import {
  DEFAULT_HALF_LIFE_SEC,
  FrecencyCache,
  SEARCH_TERM_WINDOW_MS,
  decayScore,
  decode,
  frecencyDateFromRecord,
  matchSearchTerms,
  visit,
} from "./frecency";

const DAY = 86_400;
const HL = DEFAULT_HALF_LIFE_SEC;

describe("decode / visit (future-date encoding)", () => {
  it("a never-visited item decodes to 1", () => {
    expect(decode(undefined, 1_000_000)).toBe(1);
    expect(decode(Number.NaN, 1_000_000)).toBe(1);
  });

  it("a fresh visit decodes to ≈ 101", () => {
    const now = 1_700_000_000;
    const date = visit(undefined, now);
    expect(decode(date, now)).toBeCloseTo(101, 6);
  });

  it("decays to ≈ 50.5 after one half-life and floors at 1", () => {
    const now = 1_700_000_000;
    const date = visit(undefined, now);
    expect(decode(date, now + HL)).toBeCloseTo(50.5, 6);
    expect(decode(date, now + 2 * HL)).toBeCloseTo(25.25, 6);
    expect(decode(date, now + 100 * HL)).toBe(1);
  });

  it("repeated visits accumulate (+100 on the decayed score)", () => {
    const now = 1_700_000_000;
    let date = visit(undefined, now);
    date = visit(date, now);
    expect(decode(date, now)).toBeCloseTo(201, 6);
    date = visit(date, now + HL); // 201/2 + 100
    expect(decode(date, now + HL)).toBeCloseTo(200.5, 6);
  });

  it("a visit with a stale (past) date uses max(old, now) as base", () => {
    const now = 1_700_000_000;
    const date = visit(now - 50 * DAY, now);
    expect(decode(date, now)).toBeCloseTo(101, 6);
  });

  it("honours a custom half-life", () => {
    const now = 0;
    const hl = 5 * DAY;
    const date = visit(undefined, now, hl);
    expect(decode(date, now + hl, hl)).toBeCloseTo(50.5, 6);
  });

  it("decayScore mirrors the JS-side cache decay", () => {
    expect(decayScore(101, 0, HL * 1000)).toBeCloseTo(50.5, 6);
    expect(decayScore(101, 1000, 0)).toBe(101);
    expect(decayScore(1.2, 0, HL * 1000 * 10)).toBe(1);
  });
});

describe("frecencyDateFromRecord", () => {
  it("folds visit() over the recorded launches (oldest first)", () => {
    const t0 = 1_700_000_000_000;
    const rec: UsageRecord = { itemId: "a", launches: [t0 + 1000, t0], count: 2, lastLaunchedAt: t0 + 1000 };
    const date = frecencyDateFromRecord(rec)!;
    expect(decode(date, (t0 + 1000) / 1000)).toBeCloseTo(201, 3);
  });

  it("launches beyond the ring are approximated at the oldest recorded timestamp", () => {
    const t0 = 1_700_000_000_000;
    const rec: UsageRecord = { itemId: "a", launches: [t0], count: 3, lastLaunchedAt: t0 };
    expect(decode(frecencyDateFromRecord(rec)!, t0 / 1000)).toBeCloseTo(301, 3);
  });

  it("returns undefined for an empty record", () => {
    expect(frecencyDateFromRecord({ itemId: "a", launches: [], count: 0, lastLaunchedAt: 0 })).toBeUndefined();
  });
});

describe("FrecencyCache + stored search terms", () => {
  it("records visits, keeps ≤3 distinct folded terms newest-first and persists them on the record", () => {
    const cache = new FrecencyCache();
    const now = 1_700_000_000_000;
    let rec = cache.recordVisit(undefined, "x", now, "Visual");
    rec = cache.recordVisit(rec, "x", now + 1, "VS Code");
    rec = cache.recordVisit(rec, "x", now + 2, "visual");
    rec = cache.recordVisit(rec, "x", now + 3, "code");
    expect(rec.count).toBe(4);
    expect(rec.launches).toHaveLength(4);
    expect((rec as { searchTerms?: string[] }).searchTerms).toEqual(["code", "visual", "vs code"]);
    expect(cache.score("x", now + 3)).toBeCloseTo(401, 3);
  });

  it("boosts within 17 days of the last launch and not after", () => {
    const cache = new FrecencyCache();
    const now = 1_700_000_000_000;
    cache.recordVisit(undefined, "x", now, "note");
    expect(cache.termsEligible("x", now + SEARCH_TERM_WINDOW_MS - 1)).toEqual(["note"]);
    expect(cache.termsEligible("x", now + SEARCH_TERM_WINDOW_MS + 1)).toEqual([]);
  });

  it("requires frecency > 1", () => {
    const cache = new FrecencyCache();
    const now = 1_700_000_000_000;
    const rec = cache.recordVisit(undefined, "x", now, "note");
    // reload with a record whose launch is so old that the score floors at 1, but lastLaunchedAt recent
    const stale = { ...rec, launches: [now - 400 * DAY * 1000], lastLaunchedAt: now - 1000 };
    cache.load([stale], now);
    expect(cache.score("x", now)).toBe(1);
    expect(cache.termsEligible("x", now)).toEqual([]);
  });

  it("load() restores terms from persisted records", () => {
    const cache = new FrecencyCache();
    const now = 1_700_000_000_000;
    const rec = cache.recordVisit(undefined, "x", now, "Slack");
    const fresh = new FrecencyCache();
    fresh.load([rec], now + 1000);
    expect(fresh.termsEligible("x", now + 1000)).toEqual(["slack"]);
    expect(fresh.score("x", now + 1000)).toBeCloseTo(101, 2);
  });
});

describe("matchSearchTerms", () => {
  it("exact > prefix > overbounds, overbounds only for 1..3 extra chars", () => {
    expect(matchSearchTerms(["slack"], "slack")).toEqual({ kind: "exact" });
    expect(matchSearchTerms(["slack"], "sla")).toEqual({ kind: "prefix" });
    expect(matchSearchTerms(["sla"], "slack")).toEqual({ kind: "overbounds", count: 3 });
    expect(matchSearchTerms(["s"], "slack")).toEqual({ kind: "unmatched" });
    expect(matchSearchTerms(["sl", "sla"], "slack")).toEqual({ kind: "overbounds", count: 3 });
    expect(matchSearchTerms(["slack", "sla"], "sla")).toEqual({ kind: "exact" });
  });
});
