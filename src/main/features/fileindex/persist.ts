/**
 * Binary index format "GLFI" v1 (all little-endian, every section 8-byte aligned):
 *
 *   header (64 B): magic "GLFI" | u32 format | u32 N entries | u32 T tokens |
 *                  u32 P postings | u32 namesBytes | u32 tokensBytes | u32 reserved |
 *                  f64 generation | f64 builtAt | 16 B reserved
 *   f64[N] size | f64[N] mtime | f64[N] atime
 *   i32[N] parent | u32[T+1] postOff | i32[P] postData
 *   u8[N] flags | utf8 names joined by "\0" | utf8 tokens joined by "\0"
 *
 * Typed arrays are views onto the loaded buffer, so loading is one read, two
 * UTF-8 decodes and two splits — no per-entry parsing.
 */
import { FileIndexDb } from "./db";

const MAGIC = 0x49464c47; // "GLFI" read as little-endian u32
export const FORMAT_VERSION = 1;
const HEADER = 64;

const align8 = (n: number) => (n + 7) & ~7;

export function serialize(source: FileIndexDb): Uint8Array {
  const db = source.needsCompaction() || source.count !== source.live ? source.compacted() : source;
  const n = db.count;
  const t = db.tokens.length;
  const p = db.postData.length;
  const enc = new TextEncoder();
  const names = enc.encode(db.names.slice(0, n).join("\0"));
  const tokens = enc.encode(db.tokens.join("\0"));

  let off = HEADER;
  const sizeOff = off; off += n * 8;
  const mtimeOff = off; off += n * 8;
  const atimeOff = off; off += n * 8;
  const parentOff = off; off = align8(off + n * 4);
  const postOffOff = off; off = align8(off + (t + 1) * 4);
  const postDataOff = off; off = align8(off + p * 4);
  const flagsOff = off; off = align8(off + n);
  const namesOff = off; off = align8(off + names.length);
  const tokensOff = off; off += tokens.length;

  const buf = new ArrayBuffer(off);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, FORMAT_VERSION, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, t, true);
  dv.setUint32(16, p, true);
  dv.setUint32(20, names.length, true);
  dv.setUint32(24, tokens.length, true);
  dv.setFloat64(32, db.generation, true);
  dv.setFloat64(40, db.builtAt, true);
  new Float64Array(buf, sizeOff, n).set(db.size.subarray(0, n));
  new Float64Array(buf, mtimeOff, n).set(db.mtime.subarray(0, n));
  new Float64Array(buf, atimeOff, n).set(db.atime.subarray(0, n));
  new Int32Array(buf, parentOff, n).set(db.parent.subarray(0, n));
  new Uint32Array(buf, postOffOff, t + 1).set(db.postOff.subarray(0, t + 1));
  new Int32Array(buf, postDataOff, p).set(db.postData);
  u8.set(db.flags.subarray(0, n), flagsOff);
  u8.set(names, namesOff);
  u8.set(tokens, tokensOff);
  return u8;
}

export class IndexFormatError extends Error {}

export function deserialize(input: Uint8Array): FileIndexDb {
  // Typed views need an aligned, exclusively owned buffer (Node pools small Buffers).
  const bytes = input.byteOffset % 8 === 0 ? input : input.slice();
  const buf = bytes.buffer;
  const base = bytes.byteOffset;
  if (bytes.byteLength < HEADER) throw new IndexFormatError("index file truncated");
  const dv = new DataView(buf, base, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new IndexFormatError("not a Glide file index");
  if (dv.getUint32(4, true) !== FORMAT_VERSION) throw new IndexFormatError("index format version mismatch");
  const n = dv.getUint32(8, true);
  const t = dv.getUint32(12, true);
  const p = dv.getUint32(16, true);
  const namesLen = dv.getUint32(20, true);
  const tokensLen = dv.getUint32(24, true);
  const generation = dv.getFloat64(32, true);
  const builtAt = dv.getFloat64(40, true);

  let off = HEADER;
  const sizeOff = off; off += n * 8;
  const mtimeOff = off; off += n * 8;
  const atimeOff = off; off += n * 8;
  const parentOff = off; off = align8(off + n * 4);
  const postOffOff = off; off = align8(off + (t + 1) * 4);
  const postDataOff = off; off = align8(off + p * 4);
  const flagsOff = off; off = align8(off + n);
  const namesOff = off; off = align8(off + namesLen);
  const tokensOff = off; off += tokensLen;
  if (off > bytes.byteLength) throw new IndexFormatError("index file truncated");

  const dec = new TextDecoder();
  const names = n ? dec.decode(bytes.subarray(namesOff, namesOff + namesLen)).split("\0") : [];
  const tokens = t ? dec.decode(bytes.subarray(tokensOff, tokensOff + tokensLen)).split("\0") : [];
  if (names.length !== n || tokens.length !== t) throw new IndexFormatError("index string tables are corrupt");

  return FileIndexDb.fromColumns({
    names,
    size: new Float64Array(buf, base + sizeOff, n),
    mtime: new Float64Array(buf, base + mtimeOff, n),
    atime: new Float64Array(buf, base + atimeOff, n),
    parent: new Int32Array(buf, base + parentOff, n),
    postOff: new Uint32Array(buf, base + postOffOff, t + 1),
    postData: new Int32Array(buf, base + postDataOff, p),
    flags: new Uint8Array(buf, base + flagsOff, n),
    tokens,
    generation,
    builtAt,
  });
}
