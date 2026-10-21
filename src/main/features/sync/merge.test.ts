import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type UserData, type Workflow } from "@shared/types";
import { findConflicts, flatten, machineSlug, mergeSnapshots, parseSyncFile, previewChanges, stableStringify, trackLocal, unflatten, valuesOf, type Snapshot } from "./merge";

const wf = (id: string, name: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name, icon: { kind: "emoji", value: "⚡" }, actions: [], createdAt: 1, updatedAt: 1, ...extra });

function data(over: Partial<UserData> = {}): UserData {
  return {
    settings: { ...DEFAULT_SETTINGS, features: { ai: { model: "x", apiKey: "sk-secret" }, sync: { folder: "/Users/me/iCloud" }, appearance: { darkTheme: "nord" } } },
    workflows: [wf("w1", "One"), wf("w2", "Two")],
    quicklinks: [{ id: "q1", name: "Docs", url: "https://x/{query}" }],
    snippets: [{ id: "s1", name: "Sig", text: "Best" }],
    favorites: ["app:safari"],
    aliases: { "app:safari": "sf" },
    hotkeys: { "wf:w1": "Alt+1" },
    ...over,
  };
}

describe("flatten / unflatten", () => {
  it("round-trips UserData and keeps local-only state", () => {
    const d = data();
    const back = unflatten(d, flatten(d));
    expect(back).toEqual(d);
  });
  it("excludes secrets, the sync feature bag and launchAtLogin", () => {
    const flat = flatten(data());
    expect(flat["feature.ai"]).toEqual({ model: "x" });
    expect(stableStringify(flat)).not.toContain("sk-secret");
    expect(flat["feature.sync"]).toBeUndefined();
    expect(flat["settings.launchAtLogin"]).toBeUndefined();
    expect(flat["settings.vimMode"]).toBe(true);
  });
  it("applying remote values keeps this machine's secrets and sync folder", () => {
    const local = data();
    const remote = flatten(data({ settings: { ...data().settings, vimMode: false, features: { ai: { model: "y" }, appearance: {} } } }));
    const out = unflatten(local, remote);
    expect(out.settings.vimMode).toBe(false);
    expect(out.settings.features.ai).toEqual({ model: "y", apiKey: "sk-secret" });
    expect(out.settings.features.sync).toEqual({ folder: "/Users/me/iCloud" });
  });
  it("collections become exactly the listed items, existing order kept, new ones appended", () => {
    const d = data();
    const values = flatten(d);
    delete values["workflow.w1"];
    values["workflow.w0"] = wf("w0", "Zero");
    values["favorite.app:notes"] = true;
    const out = unflatten(d, values);
    expect(out.workflows.map((w) => w.id)).toEqual(["w2", "w0"]);
    expect(out.favorites).toEqual(["app:safari", "app:notes"]);
  });
  it("ignores values of the wrong type", () => {
    const out = unflatten(data(), { "settings.sectionLimit": "lots", "workflow.bad": { id: "bad" } });
    expect(out.settings.sectionLimit).toBe(DEFAULT_SETTINGS.sectionLimit);
    expect(out.workflows).toEqual([]);
  });
});

describe("trackLocal", () => {
  it("stamps new and changed items, keeps unchanged stamps, tombstones removals", () => {
    const s1 = trackLocal({}, { a: 1, b: { x: 1, y: 2 } }, 100, "mac1");
    expect(s1).toEqual({ a: { v: 1, t: 100, m: "mac1" }, b: { v: { x: 1, y: 2 }, t: 100, m: "mac1" } });
    const s2 = trackLocal(s1, { a: 2, b: { y: 2, x: 1 } }, 200, "mac1");
    expect(s2.a).toEqual({ v: 2, t: 200, m: "mac1" });
    expect(s2.b.t).toBe(100); // key order does not count as a change
    const s3 = trackLocal(s2, { b: { x: 1, y: 2 } }, 300, "mac1");
    expect(s3.a).toEqual({ v: null, t: 300, m: "mac1", d: true });
    const s4 = trackLocal(s3, { b: { x: 1, y: 2 } }, 400, "mac1");
    expect(s4.a.t).toBe(300); // tombstone kept as is
    const s5 = trackLocal(s4, { b: { x: 1, y: 2 } }, 300 + 91 * 24 * 3600 * 1000, "mac1");
    expect(s5.a).toBeUndefined(); // expired tombstone pruned
  });
  it("re-adding a deleted item stamps it fresh", () => {
    const s = trackLocal({ a: { v: null, t: 50, m: "x", d: true } }, { a: 1 }, 60, "mac1");
    expect(s.a).toEqual({ v: 1, t: 60, m: "mac1" });
  });
});

describe("mergeSnapshots", () => {
  const A: Snapshot = { k1: { v: "a", t: 10, m: "alpha" }, k2: { v: "a", t: 30, m: "alpha" }, k3: { v: "a", t: 5, m: "alpha" } };
  const B: Snapshot = { k1: { v: "b", t: 20, m: "beta" }, k2: { v: null, t: 25, m: "beta", d: true }, k4: { v: "b", t: 1, m: "beta" } };
  const C: Snapshot = { k3: { v: null, t: 7, m: "gamma", d: true }, k1: { v: "c", t: 20, m: "gamma" } };

  it("newest wins per key, tombstones included", () => {
    const m = mergeSnapshots([A, B, C]);
    expect(m.k1).toEqual({ v: "c", t: 20, m: "gamma" }); // tie at t=20 → higher machine name
    expect(m.k2.v).toBe("a");
    expect(m.k3.d).toBe(true);
    expect(valuesOf(m)).toEqual({ k1: "c", k2: "a", k4: "b" });
  });
  it("is deterministic regardless of input order", () => {
    const perms = [
      [A, B, C],
      [C, B, A],
      [B, A, C],
      [B, C, A],
    ];
    const results = perms.map((p) => stableStringify(mergeSnapshots(p)));
    expect(new Set(results).size).toBe(1);
  });
  it("is idempotent", () => {
    const m = mergeSnapshots([A, B, C]);
    expect(mergeSnapshots([m, A, B, C])).toEqual(m);
  });
  it("skips malformed entries", () => {
    expect(mergeSnapshots([{ k: { v: 1, t: Number.NaN, m: "x" } } as Snapshot, { k: { v: 2, t: 1, m: "y" } }])).toEqual({ k: { v: 2, t: 1, m: "y" } });
  });
});

describe("conflicts", () => {
  it("reports keys changed on both machines since the last sync", () => {
    const local: Snapshot = { a: { v: 1, t: 150, m: "me" }, b: { v: 1, t: 50, m: "me" }, c: { v: { name: "Same" }, t: 150, m: "me" } };
    const other: Snapshot = { a: { v: 2, t: 160, m: "you" }, b: { v: 2, t: 170, m: "you" }, c: { v: { name: "Same" }, t: 160, m: "you" } };
    const merged = mergeSnapshots([local, other]);
    const conflicts = findConflicts(local, [{ machine: "you", entries: other }], 100, merged, 999);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: "a", winner: { machine: "you", t: 160 }, loser: { machine: "me", t: 150 } });
  });
});

describe("preview and files", () => {
  it("previews added / removed / changed items", () => {
    const cur = data();
    const target = flatten(cur);
    delete target["quicklink.q1"];
    target["snippet.s2"] = { id: "s2", name: "New", text: "x" };
    target["workflow.w1"] = wf("w1", "One renamed");
    const p = previewChanges(cur, target);
    expect(p.added.map((x) => x.label)).toEqual(["Snippet “New”"]);
    expect(p.removed.map((x) => x.label)).toEqual(["Quicklink “Docs”"]);
    expect(p.changed.map((x) => x.label)).toEqual(["Workflow “One renamed”"]);
  });
  it("parses only Glide sync files of a known version", () => {
    expect(parseSyncFile({ app: "other" })).toBeNull();
    expect(parseSyncFile({ app: "glide", version: 99, machine: "m", entries: {} })).toBeNull();
    const f = parseSyncFile({ app: "glide", version: 1, machine: "m", exportedAt: 5, entries: { "a.b": { v: 1, t: 1, m: "m" }, junk: { v: 1, t: 1, m: "m" }, "c.d": { t: "x" } } });
    expect(f?.entries).toEqual({ "a.b": { v: 1, t: 1, m: "m" } });
  });
  it("machine slugs are file-name safe", () => {
    expect(machineSlug("Tobi’s MacBook Pro.local")).toBe("Tobi-s MacBook Pro");
    expect(machineSlug("///")).toBe("Mac");
    expect(machineSlug("")).toBe("Mac");
  });
});
