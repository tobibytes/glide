import { describe, expect, it } from "vitest";
import { deserialize, IndexFormatError, serialize } from "../persist";
import { buildFake } from "./helpers";

describe("index persistence", () => {
  it("round-trips entries, postings and metadata", () => {
    const db = buildFake("/root", [{ path: "Docs/Report Final.pdf", size: 1234, mtime: 1_700_000_000_000 }, { path: "café/notes.md" }, { path: "Projects/glide/" }]);
    db.generation = 7;
    const back = deserialize(serialize(db));
    expect(back.count).toBe(db.count);
    expect(back.generation).toBe(7);
    expect(back.tokens).toEqual(db.tokens);
    const id = back.findPath("/root/Docs/Report Final.pdf");
    expect(id).toBeGreaterThan(0);
    expect(back.size[id]).toBe(1234);
    expect(back.mtime[id]).toBe(1_700_000_000_000);
    expect(back.isDir(back.findPath("/root/Projects/glide"))).toBe(true);
    const hits: number[] = [];
    back.forEachPrefix("repo", (i) => hits.push(i));
    expect(hits).toContain(id);
  });

  it("drops tombstones and delta on save, keeping additions", () => {
    const db = buildFake("/root", [{ path: "a/one.txt" }, { path: "a/two.txt" }]);
    db.remove(db.findPath("/root/a/one.txt"));
    db.add("three.txt", db.findPath("/root/a"), { isDir: false, size: 3, mtime: 1, atime: 0 });
    const back = deserialize(serialize(db));
    expect(back.findPath("/root/a/one.txt")).toBe(-1);
    expect(back.findPath("/root/a/three.txt")).toBeGreaterThan(0);
    expect(back.count).toBe(back.live);
    const hits: string[] = [];
    back.forEachPrefix("three", (i) => hits.push(back.pathOf(i)));
    expect([...new Set(hits)]).toEqual(["/root/a/three.txt"]); // "three" and the joined "threetxt" both match
  });

  it("rejects foreign or truncated files", () => {
    expect(() => deserialize(new Uint8Array(10))).toThrow(IndexFormatError);
    const bytes = serialize(buildFake("/r", [{ path: "x" }]));
    expect(() => deserialize(bytes.subarray(0, bytes.length - 3))).toThrow(IndexFormatError);
    const bad = bytes.slice();
    bad[0] = 0;
    expect(() => deserialize(bad)).toThrow(IndexFormatError);
  });
});
