import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createTar, createTgz, extractTgz, readTar, safeEntryPath, TarError } from "./store-tar";

const tmps: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "glide-tar-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A raw ustar header with an arbitrary name/type, for fixtures our writer refuses to produce. */
function rawEntry(name: string, type: string, data = Buffer.alloc(0), linkname = ""): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([h, data, pad]);
}
const gz = (...parts: Buffer[]) => zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));

describe("store tar extraction", () => {
  it("round-trips files, folders and modes, stripping npm's package/ prefix", () => {
    const dest = path.join(tmp(), "out");
    const files = extractTgz(
      createTgz([
        { path: "package/package.json", data: '{"name":"x"}' },
        { path: "package/dist" },
        { path: "package/dist/run.js", data: "module.exports = 1", mode: 0o755 },
        { path: `package/assets/${"d".repeat(90)}/${"f".repeat(60)}.txt`, data: "long path via ustar prefix" },
      ]),
      dest,
    );
    expect(files).toContain("dist/run.js");
    expect(fs.readFileSync(path.join(dest, "package.json"), "utf8")).toBe('{"name":"x"}');
    expect(fs.statSync(path.join(dest, "dist/run.js")).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(dest, "assets", "d".repeat(90), `${"f".repeat(60)}.txt`))).toBe(true);
  });

  it.each([
    ["../evil.txt", /traversal/],
    ["package/../../evil.txt", /traversal/],
    ["/etc/evil", /Absolute/],
    ["C:/evil", /Absolute/],
    ["a\\..\\evil", /Backslash/],
  ])("rejects hostile path %s", (name, re) => {
    const dir = tmp();
    const dest = path.join(dir, "out");
    expect(() => extractTgz(gz(rawEntry(name, "0", Buffer.from("x"))), dest)).toThrow(re);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.join(dir, "evil.txt"))).toBe(false);
  });

  it("rejects symlinks, hard links and devices before writing anything", () => {
    const sym = createTar([{ path: "package.json", data: "{}" }, { path: "link", link: { type: "symlink", target: "/etc/passwd" } }]);
    const hard = createTar([{ path: "package.json", data: "{}" }, { path: "hl", link: { type: "hardlink", target: "/etc/passwd" } }]);
    for (const [buf, re] of [
      [sym, /symbolic link/],
      [hard, /hard link/],
      [Buffer.concat([rawEntry("dev", "3"), Buffer.alloc(1024)]), /device/],
      [Buffer.concat([rawEntry("fifo", "6"), Buffer.alloc(1024)]), /FIFO/],
    ] as const) {
      const dest = path.join(tmp(), "out");
      expect(() => extractTgz(zlib.gzipSync(buf), dest)).toThrow(re);
      expect(fs.existsSync(dest)).toBe(false);
    }
  });

  it("rejects pax and GNU long names that traverse", () => {
    const paxData = Buffer.from("27 path=../../pax-evil.txt\n");
    expect(() => readTar(Buffer.concat([rawEntry("PaxHeader", "x", paxData), rawEntry("ok.txt", "0", Buffer.from("x")), Buffer.alloc(1024)]))).toThrow(/traversal/);
    const longName = Buffer.from("../../gnu-evil.txt\0");
    expect(() => readTar(Buffer.concat([rawEntry("././@LongLink", "L", longName), rawEntry("ok.txt", "0", Buffer.from("x")), Buffer.alloc(1024)]))).toThrow(/traversal/);
  });

  it("rejects duplicate paths and files nested under files", () => {
    expect(() => readTar(createTar([{ path: "a", data: "1" }, { path: "a", data: "2" }]))).toThrow(/Duplicate/);
    expect(() => readTar(createTar([{ path: "a", data: "1" }, { path: "a/b", data: "2" }]))).toThrow(/inside a file/);
  });

  it("rejects corrupt, truncated and oversized archives", () => {
    const t = createTar([{ path: "a.txt", data: "hello" }]);
    const bad = Buffer.from(t);
    bad[0] = 0x41;
    expect(() => readTar(bad)).toThrow(/checksum/);
    expect(() => readTar(createTar([{ path: "a.txt", data: Buffer.alloc(2000, 1) }]).subarray(0, 1000))).toThrow(/Truncated/);
    expect(() => readTar(createTar([{ path: "big", data: Buffer.alloc(2048) }]), { maxEntries: 10, maxTotalBytes: 1000, maxFileBytes: 4096 })).toThrow(/too large/);
    expect(() => extractTgz(Buffer.from("not gzip"), path.join(tmp(), "o"))).toThrow(TarError);
    const bomb = zlib.gzipSync(createTar([{ path: "zeros", data: Buffer.alloc(4 * 1024 * 1024) }]));
    expect(() => extractTgz(bomb, path.join(tmp(), "o"), { maxEntries: 10, maxTotalBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 })).toThrow(/too large/);
  });

  it("refuses to extract into an existing destination", () => {
    const dest = tmp();
    expect(() => extractTgz(createTgz([{ path: "package.json", data: "{}" }]), dest)).toThrow(/already exists/);
  });

  it("normalises safe paths", () => {
    expect(safeEntryPath("./package//dist/./a.js")).toBe("package/dist/a.js");
    expect(() => safeEntryPath("./")).toThrow(/Empty/);
  });
});
