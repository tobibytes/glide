/**
 * Native Glide extension host (JavaScriptCore). Bundled at BUILD time by build.mjs into
 * Sources/Features/Extensions/Runtime/ExtensionRuntimeJS.swift; the app needs no Node.
 *
 * It reuses the Electron runtimes unchanged (src/extension-api/runtime.ts for Glide-style commands,
 * src/extension-api/raycast/* for Raycast React commands) and supplies what Node/Electron gave them:
 * a CommonJS loader with Module._resolveFilename, timers, fetch/Headers/Response, AbortController,
 * URL/URLSearchParams, TextEncoder/Decoder, Buffer, atob/btoa, crypto, process, and shims for the
 * Node built-ins extensions commonly use (fs, path, os, crypto, events, util, buffer, url, querystring,
 * child_process [execFile/exec only]). Everything native goes through `__native` (installed by Swift).
 */
import { glideRuntime, API_SHIM_SOURCE } from "../../../src/extension-api/runtime";
import { raycastRuntime, RAYCAST_SHIMS } from "../../../src/extension-api/raycast/runtime";
import { createMiniReact } from "../../../src/extension-api/raycast/react";
import { createRaycastSerializer } from "../../../src/extension-api/raycast/serialize";
import { createRaycastApi } from "../../../src/extension-api/raycast/api";
import { createRaycastUtils } from "../../../src/extension-api/raycast/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const __native: any;
const G: any = globalThis as any;
const N: any = __native;

// ---------------------------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------------------------
function fmt(v: unknown, depth = 0): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ? `${v.name}: ${v.message}\n${v.stack}` : `${v.name}: ${v.message}`;
  if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
  if (typeof v !== "object" || v === null) return String(v);
  if (depth > 2) return Array.isArray(v) ? "[Array]" : "[Object]";
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
  } catch {
    return Object.prototype.toString.call(v);
  }
}
const format = (args: unknown[]) => {
  if (typeof args[0] === "string" && /%[sdifoOj%]/.test(args[0])) {
    let i = 1;
    const s = (args[0] as string).replace(/%([sdifoOj%])/g, (m, c) => {
      if (c === "%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      if (c === "d" || c === "i") return String(parseInt(String(a), 10));
      if (c === "f") return String(Number(a));
      if (c === "s") return String(a);
      return fmt(a);
    });
    return [s, ...args.slice(i).map((a) => fmt(a))].join(" ");
  }
  return args.map((a) => fmt(a)).join(" ");
};
const mkLog = (level: string) => (...a: unknown[]) => N.log(level, format(a));
G.console = { log: mkLog("log"), info: mkLog("log"), debug: mkLog("log"), warn: mkLog("warn"), error: mkLog("error"), trace: mkLog("log"), dir: mkLog("log"), time() {}, timeEnd() {}, assert(c: unknown, ...a: unknown[]) { if (!c) N.log("error", "Assertion failed " + format(a)); } };

// ---------------------------------------------------------------------------------------------
// microtasks, timers
// ---------------------------------------------------------------------------------------------
G.queueMicrotask = (fn: () => void) => void Promise.resolve().then(fn).catch((e) => reportUncaught(e));
let timerSeq = 0;
const timers = new Map<number, { fn: (...a: any[]) => void; args: any[]; repeat: number | null }>();
class Timeout {
  constructor(readonly id: number) {}
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  refresh() { return this; }
  [Symbol.toPrimitive]() { return this.id; }
}
const timerId = (t: unknown) => (t instanceof Timeout ? t.id : Number(t));
function addTimer(fn: any, ms: any, args: any[], repeat: boolean) {
  if (typeof fn !== "function") throw new TypeError("Callback must be a function");
  const id = ++timerSeq;
  const delay = Math.max(0, Number(ms) || 0);
  timers.set(id, { fn, args, repeat: repeat ? Math.max(1, delay) : null });
  N.setTimer(id, delay);
  return new Timeout(id);
}
G.setTimeout = (fn: any, ms?: any, ...args: any[]) => addTimer(fn, ms, args, false);
G.setInterval = (fn: any, ms?: any, ...args: any[]) => addTimer(fn, ms, args, true);
G.setImmediate = (fn: any, ...args: any[]) => addTimer(fn, 0, args, false);
G.clearTimeout = G.clearInterval = G.clearImmediate = (t: unknown) => {
  const id = timerId(t);
  if (timers.delete(id)) N.clearTimer(id);
};
function timerFired(id: number) {
  const t = timers.get(id);
  if (!t) return;
  if (t.repeat === null) timers.delete(id);
  else N.setTimer(id, t.repeat);
  try {
    t.fn(...t.args);
  } catch (e) {
    reportUncaught(e);
  }
}
const t0 = N.monotonic();
G.performance = { now: () => N.monotonic() - t0, timeOrigin: Date.now(), mark() {}, measure() {} };

// ---------------------------------------------------------------------------------------------
// base64, TextEncoder/Decoder
// ---------------------------------------------------------------------------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64R = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64R[B64.charCodeAt(i)] = i;
B64R["-".charCodeAt(0)] = 62;
B64R["_".charCodeAt(0)] = 63;
function bytesToB64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}
function b64ToBytes(s: string): Uint8Array {
  const clean = String(s).replace(/[^A-Za-z0-9+/\-_]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64R[clean.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}
function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
function utf8Decode(b: Uint8Array): string {
  let out = "";
  let chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode.apply(null, chunk);
    chunk = [];
  };
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp = 0xfffd;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < b.length) (cp = ((c & 31) << 6) | (b[i + 1] & 63)), (n = 2);
    else if (c >= 0xe0 && c < 0xf0 && i + 2 < b.length) (cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63)), (n = 3);
    else if (c >= 0xf0 && c < 0xf5 && i + 3 < b.length) (cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63)), (n = 4);
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else chunk.push(cp);
    if (chunk.length > 8000) flush();
  }
  flush();
  return out;
}
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
G.btoa = (s: string) => bytesToB64(latin1(String(s)));
G.atob = (s: string) => {
  const b = b64ToBytes(String(s));
  let out = "";
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
};
class TextEncoderImpl {
  readonly encoding = "utf-8";
  encode(s = "") { return utf8Encode(String(s)); }
}
class TextDecoderImpl {
  readonly encoding: string;
  constructor(enc = "utf-8") { this.encoding = String(enc).toLowerCase(); }
  decode(b?: ArrayBuffer | ArrayBufferView) {
    if (!b) return "";
    const u = b instanceof Uint8Array ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
    if (this.encoding === "latin1" || this.encoding === "iso-8859-1" || this.encoding === "ascii") return Array.from(u, (c) => String.fromCharCode(c)).join("");
    return utf8Decode(u);
  }
}
G.TextEncoder = TextEncoderImpl;
G.TextDecoder = TextDecoderImpl;

// ---------------------------------------------------------------------------------------------
// Buffer (the subset extensions and the runtimes use)
// ---------------------------------------------------------------------------------------------
type Enc = string | undefined;
function encodeString(s: string, enc: Enc): Uint8Array {
  switch ((enc ?? "utf8").toLowerCase()) {
    case "hex": {
      const out = new Uint8Array(Math.floor(s.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
      return out;
    }
    case "base64":
    case "base64url":
      return b64ToBytes(s);
    case "latin1":
    case "binary":
    case "ascii":
      return latin1(s);
    default:
      return utf8Encode(s);
  }
}
class BufferImpl extends Uint8Array {
  static from(v: any, encOrOffset?: any, len?: number): BufferImpl {
    if (typeof v === "string") return BufferImpl.wrap(encodeString(v, encOrOffset));
    if (v instanceof ArrayBuffer) return BufferImpl.wrap(new Uint8Array(v, encOrOffset ?? 0, len ?? v.byteLength - (encOrOffset ?? 0)));
    if (ArrayBuffer.isView(v)) return BufferImpl.wrap(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    if (v && v.type === "Buffer" && Array.isArray(v.data)) return BufferImpl.wrap(Uint8Array.from(v.data));
    if (Array.isArray(v) || (v && typeof v.length === "number")) return BufferImpl.wrap(Uint8Array.from(v as ArrayLike<number>));
    throw new TypeError("Buffer.from: unsupported argument");
  }
  static wrap(u: Uint8Array): BufferImpl {
    const b = new BufferImpl(u.length);
    b.set(u);
    return b;
  }
  static alloc(n: number, fill?: number | string) {
    const b = new BufferImpl(n);
    if (typeof fill === "number") b.fill(fill);
    else if (typeof fill === "string" && fill.length) b.fill(fill.charCodeAt(0));
    return b;
  }
  static allocUnsafe(n: number) { return new BufferImpl(n); }
  static isBuffer(v: unknown): v is BufferImpl { return v instanceof BufferImpl; }
  static isEncoding(e: string) { return ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii"].includes(String(e).toLowerCase()); }
  static byteLength(s: any, enc?: Enc) { return typeof s === "string" ? encodeString(s, enc).length : s.byteLength; }
  static concat(list: Uint8Array[], total?: number) {
    const len = total ?? list.reduce((a, b) => a + b.length, 0);
    const out = new BufferImpl(len);
    let o = 0;
    for (const b of list) {
      out.set(b.subarray(0, Math.min(b.length, len - o)), o);
      o += b.length;
      if (o >= len) break;
    }
    return out;
  }
  static compare(a: Uint8Array, b: Uint8Array) { return BufferImpl.prototype.compare.call(a, b); }
  toString(enc?: Enc, start = 0, end = this.length): string {
    const u = this.subarray(start, end);
    switch ((enc ?? "utf8").toLowerCase()) {
      case "hex":
        return Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");
      case "base64":
        return bytesToB64(u);
      case "base64url":
        return bytesToB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      case "latin1":
      case "binary":
      case "ascii":
        return Array.from(u, (c) => String.fromCharCode(c)).join("");
      default:
        return utf8Decode(u);
    }
  }
  toJSON() { return { type: "Buffer", data: Array.from(this) }; }
  equals(o: Uint8Array) { return this.length === o.length && this.every((x, i) => x === o[i]); }
  compare(o: Uint8Array) {
    for (let i = 0; i < Math.min(this.length, o.length); i++) if (this[i] !== o[i]) return this[i] < o[i] ? -1 : 1;
    return this.length === o.length ? 0 : this.length < o.length ? -1 : 1;
  }
  slice(s?: number, e?: number) { return BufferImpl.wrap(super.slice(s, e)); }
  write(s: string, offset = 0, _len?: number, enc?: Enc) {
    const b = encodeString(s, enc);
    this.set(b.subarray(0, this.length - offset), offset);
    return Math.min(b.length, this.length - offset);
  }
  copy(target: Uint8Array, ts = 0, ss = 0, se = this.length) {
    const part = this.subarray(ss, se);
    target.set(part.subarray(0, target.length - ts), ts);
    return Math.min(part.length, target.length - ts);
  }
  includes(v: any, from = 0): boolean { return this.indexOf(v, from) >= 0; }
  indexOf(v: any, from = 0): number {
    if (typeof v === "number") return super.indexOf(v, from);
    const n = typeof v === "string" ? utf8Encode(v) : (v as Uint8Array);
    outer: for (let i = from; i <= this.length - n.length; i++) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }
  readUInt8(o = 0) { return this[o]; }
  readUInt32BE(o = 0) { return ((this[o] << 24) >>> 0) + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
}
G.Buffer = BufferImpl;

// ---------------------------------------------------------------------------------------------
// Event / EventTarget / AbortController / DOMException
// ---------------------------------------------------------------------------------------------
class DOMExceptionImpl extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
  get code() { return this.name === "AbortError" ? 20 : this.name === "TimeoutError" ? 23 : 0; }
}
G.DOMException = DOMExceptionImpl;
class EventImpl {
  type: string;
  defaultPrevented = false;
  target: any = null;
  timeStamp = Date.now();
  constructor(type: string, init?: any) {
    this.type = String(type);
    if (init?.detail !== undefined) (this as any).detail = init.detail;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() {}
}
class EventTargetImpl {
  private __l = new Map<string, Array<{ fn: any; once: boolean }>>();
  addEventListener(type: string, fn: any, opts?: any) {
    if (!fn) return;
    const list = this.__l.get(type) ?? [];
    if (list.some((l) => l.fn === fn)) return;
    list.push({ fn, once: !!(opts && typeof opts === "object" && opts.once) });
    this.__l.set(type, list);
  }
  removeEventListener(type: string, fn: any) {
    const list = this.__l.get(type);
    if (list) this.__l.set(type, list.filter((l) => l.fn !== fn));
  }
  dispatchEvent(ev: any) {
    ev.target = this;
    const on = (this as any)[`on${ev.type}`];
    if (typeof on === "function") on.call(this, ev);
    for (const l of [...(this.__l.get(ev.type) ?? [])]) {
      if (l.once) this.removeEventListener(ev.type, l.fn);
      try {
        typeof l.fn === "function" ? l.fn.call(this, ev) : l.fn.handleEvent(ev);
      } catch (e) {
        reportUncaught(e);
      }
    }
    return !ev.defaultPrevented;
  }
}
G.Event = EventImpl;
G.CustomEvent = EventImpl;
G.EventTarget = EventTargetImpl;
class AbortSignalImpl extends EventTargetImpl {
  aborted = false;
  reason: any = undefined;
  onabort: any = null;
  throwIfAborted() { if (this.aborted) throw this.reason; }
  static abort(reason?: any) {
    const c = new AbortControllerImpl();
    c.abort(reason);
    return c.signal;
  }
  static timeout(ms: number) {
    const c = new AbortControllerImpl();
    G.setTimeout(() => c.abort(new DOMExceptionImpl("The operation timed out.", "TimeoutError")), ms);
    return c.signal;
  }
  static any(signals: AbortSignalImpl[]) {
    const c = new AbortControllerImpl();
    for (const s of signals) {
      if (s.aborted) {
        c.abort(s.reason);
        break;
      }
      s.addEventListener("abort", () => c.abort(s.reason), { once: true });
    }
    return c.signal;
  }
}
class AbortControllerImpl {
  readonly signal = new AbortSignalImpl();
  abort(reason?: any) {
    const s = this.signal;
    if (s.aborted) return;
    s.aborted = true;
    s.reason = reason ?? new DOMExceptionImpl("This operation was aborted", "AbortError");
    s.dispatchEvent(new EventImpl("abort"));
  }
}
G.AbortController = AbortControllerImpl;
G.AbortSignal = AbortSignalImpl;

// ---------------------------------------------------------------------------------------------
// URL / URLSearchParams (parsing via Foundation)
// ---------------------------------------------------------------------------------------------
const qsEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const qsDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};
class URLSearchParamsImpl {
  private list: Array<[string, string]> = [];
  private owner?: URLImpl;
  constructor(init?: any, owner?: URLImpl) {
    this.owner = owner;
    if (typeof init === "string") this.parse(init);
    else if (init instanceof URLSearchParamsImpl) this.list = [...init.list];
    else if (Array.isArray(init)) this.list = init.map(([k, v]) => [String(k), String(v)]);
    else if (init && typeof init === "object") for (const [k, v] of Object.entries(init)) if (v !== undefined) this.list.push([k, String(v)]);
  }
  parse(s: string) {
    this.list = [];
    for (const part of s.replace(/^\?/, "").split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      this.list.push(eq < 0 ? [qsDecode(part), ""] : [qsDecode(part.slice(0, eq)), qsDecode(part.slice(eq + 1))]);
    }
  }
  private update() { this.owner?.__setSearch(this.toString()); }
  get size() { return this.list.length; }
  append(k: string, v: any) { this.list.push([String(k), String(v)]); this.update(); }
  delete(k: string) { this.list = this.list.filter(([x]) => x !== k); this.update(); }
  get(k: string) { return this.list.find(([x]) => x === k)?.[1] ?? null; }
  getAll(k: string) { return this.list.filter(([x]) => x === k).map(([, v]) => v); }
  has(k: string) { return this.list.some(([x]) => x === k); }
  set(k: string, v: any) {
    const i = this.list.findIndex(([x]) => x === k);
    if (i < 0) this.list.push([String(k), String(v)]);
    else {
      this.list[i] = [String(k), String(v)];
      this.list = this.list.filter(([x], j) => x !== k || j === i);
    }
    this.update();
  }
  sort() { this.list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this.update(); }
  forEach(fn: (v: string, k: string, p: any) => void) { for (const [k, v] of this.list) fn(v, k, this); }
  keys() { return this.list.map(([k]) => k)[Symbol.iterator](); }
  values() { return this.list.map(([, v]) => v)[Symbol.iterator](); }
  entries() { return this.list.map(([k, v]) => [k, v] as [string, string])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.list.map(([k, v]) => `${qsEncode(k)}=${qsEncode(v)}`).join("&"); }
}
interface UrlParts { protocol: string; username: string; password: string; hostname: string; port: string; pathname: string; search: string; hash: string }
class URLImpl {
  private p: UrlParts;
  private sp: URLSearchParamsImpl;
  constructor(input: any, base?: any) {
    const r = N.urlParse(String(input instanceof URLImpl ? input.href : input), base === undefined || base === null ? null : String(base instanceof URLImpl ? base.href : base));
    if (!r || r.error) throw new TypeError(`Invalid URL: ${String(input)}`);
    this.p = r as UrlParts;
    this.sp = new URLSearchParamsImpl(this.p.search, this);
  }
  static canParse(i: any, b?: any) {
    try {
      new URLImpl(i, b);
      return true;
    } catch {
      return false;
    }
  }
  __setSearch(s: string) { this.p.search = s ? `?${s}` : ""; }
  get protocol() { return this.p.protocol; }
  set protocol(v: string) { this.p.protocol = v.endsWith(":") ? v : `${v}:`; }
  get username() { return this.p.username; }
  set username(v: string) { this.p.username = v; }
  get password() { return this.p.password; }
  set password(v: string) { this.p.password = v; }
  get hostname() { return this.p.hostname; }
  set hostname(v: string) { this.p.hostname = v; }
  get port() { return this.p.port; }
  set port(v: string) { this.p.port = String(v); }
  get host() { return this.p.port ? `${this.p.hostname}:${this.p.port}` : this.p.hostname; }
  set host(v: string) {
    const [h, port] = String(v).split(":");
    this.p.hostname = h;
    this.p.port = port ?? "";
  }
  get pathname() { return this.p.pathname; }
  set pathname(v: string) { this.p.pathname = v.startsWith("/") ? v : `/${v}`; }
  get search() { return this.p.search.length > 1 ? this.p.search : ""; }
  set search(v: string) {
    this.p.search = v ? (v.startsWith("?") ? v : `?${v}`) : "";
    this.sp.parse(this.p.search);
  }
  get searchParams() { return this.sp; }
  get hash() { return this.p.hash.length > 1 ? this.p.hash : ""; }
  set hash(v: string) { this.p.hash = v ? (v.startsWith("#") ? v : `#${v}`) : ""; }
  get origin() { return /^(https?|wss?|ftp):$/.test(this.p.protocol) ? `${this.p.protocol}//${this.host}` : "null"; }
  get href() {
    const special = /^(https?|wss?|ftp|file):$/.test(this.p.protocol) || this.p.hostname !== "";
    const auth = this.p.username ? `${this.p.username}${this.p.password ? `:${this.p.password}` : ""}@` : "";
    return `${this.p.protocol}${special ? "//" : ""}${auth}${this.host}${this.p.pathname}${this.search}${this.hash}`;
  }
  set href(v: string) {
    const u = new URLImpl(v);
    this.p = u.p;
    this.sp = new URLSearchParamsImpl(this.p.search, this);
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
}
G.URL = URLImpl;
G.URLSearchParams = URLSearchParamsImpl;

// ---------------------------------------------------------------------------------------------
// crypto, structuredClone
// ---------------------------------------------------------------------------------------------
const randomBytes = (n: number) => BufferImpl.wrap(b64ToBytes(N.randomBytes(n)));
const randomUUID = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
G.crypto = {
  getRandomValues<T extends ArrayBufferView>(a: T): T {
    const b = randomBytes(a.byteLength);
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(b);
    return a;
  },
  randomUUID,
  subtle: undefined,
};
G.structuredClone = (v: any) => {
  const seen = new Map();
  const clone = (x: any): any => {
    if (typeof x !== "object" || x === null) return x;
    if (seen.has(x)) return seen.get(x);
    if (x instanceof Date) return new Date(x.getTime());
    if (x instanceof RegExp) return new RegExp(x.source, x.flags);
    if (ArrayBuffer.isView(x)) return (x as any).slice();
    if (x instanceof Map) {
      const m = new Map();
      seen.set(x, m);
      x.forEach((v2, k) => m.set(clone(k), clone(v2)));
      return m;
    }
    if (x instanceof Set) {
      const s = new Set();
      seen.set(x, s);
      x.forEach((v2) => s.add(clone(v2)));
      return s;
    }
    const out: any = Array.isArray(x) ? [] : {};
    seen.set(x, out);
    for (const k of Object.keys(x)) {
      if (typeof x[k] === "function") throw new DOMExceptionImpl("function could not be cloned", "DataCloneError");
      out[k] = clone(x[k]);
    }
    return out;
  };
  return clone(v);
};

// ---------------------------------------------------------------------------------------------
// fetch (URLSession bridge)
// ---------------------------------------------------------------------------------------------
class HeadersImpl {
  private m = new Map<string, [string, string]>();
  constructor(init?: any) {
    if (!init) return;
    if (init instanceof HeadersImpl) init.forEach((v, k) => this.append(k, v));
    else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
    else for (const [k, v] of Object.entries(init)) if (v !== undefined) this.append(k, String(v));
  }
  append(k: string, v: string) {
    const key = String(k).toLowerCase();
    const cur = this.m.get(key);
    this.m.set(key, [k, cur ? `${cur[1]}, ${v}` : String(v)]);
  }
  set(k: string, v: string) { this.m.set(String(k).toLowerCase(), [k, String(v)]); }
  get(k: string) { return this.m.get(String(k).toLowerCase())?.[1] ?? null; }
  has(k: string) { return this.m.has(String(k).toLowerCase()); }
  delete(k: string) { this.m.delete(String(k).toLowerCase()); }
  forEach(fn: (v: string, k: string, h: any) => void) { for (const [k, [, v]] of this.m) fn(v, k, this); }
  entries() { return [...this.m].map(([k, [, v]]) => [k, v] as [string, string])[Symbol.iterator](); }
  keys() { return [...this.m.keys()][Symbol.iterator](); }
  values() { return [...this.m.values()].map(([, v]) => v)[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  getSetCookie() { const c = this.get("set-cookie"); return c ? [c] : []; }
}
async function bodyBytes(body: any): Promise<Uint8Array | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof URLSearchParamsImpl) return utf8Encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof BlobImpl) return body.bytes;
  if (body instanceof FormDataImpl) return utf8Encode(new URLSearchParamsImpl(body.entries().map(([k, v]) => [k, String(v)])).toString());
  return utf8Encode(String(body));
}
class BlobImpl {
  readonly bytes: Uint8Array;
  readonly type: string;
  constructor(parts: any[] = [], opts?: any) {
    const chunks = parts.map((p) => (typeof p === "string" ? utf8Encode(p) : p instanceof BlobImpl ? p.bytes : ArrayBuffer.isView(p) ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : new Uint8Array(p)));
    this.bytes = BufferImpl.concat(chunks);
    this.type = String(opts?.type ?? "");
  }
  get size() { return this.bytes.length; }
  async text() { return utf8Decode(this.bytes); }
  async arrayBuffer() { return this.bytes.slice().buffer; }
  slice(s?: number, e?: number, type?: string) { return new BlobImpl([this.bytes.slice(s, e)], { type }); }
}
class FormDataImpl {
  private l: Array<[string, any]> = [];
  append(k: string, v: any) { this.l.push([k, v]); }
  set(k: string, v: any) { this.delete(k); this.append(k, v); }
  get(k: string) { return this.l.find(([x]) => x === k)?.[1] ?? null; }
  getAll(k: string) { return this.l.filter(([x]) => x === k).map(([, v]) => v); }
  has(k: string) { return this.l.some(([x]) => x === k); }
  delete(k: string) { this.l = this.l.filter(([x]) => x !== k); }
  entries() { return [...this.l]; }
  [Symbol.iterator]() { return this.l[Symbol.iterator](); }
}
G.Blob = BlobImpl;
G.FormData = FormDataImpl;
G.Headers = HeadersImpl;
class ResponseImpl {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeadersImpl;
  readonly url: string;
  readonly redirected = false;
  readonly type = "basic";
  private bytes: Uint8Array;
  bodyUsed = false;
  constructor(body?: any, init?: any) {
    this.bytes = typeof body === "string" ? utf8Encode(body) : body instanceof Uint8Array ? body : body ? utf8Encode(String(body)) : new Uint8Array(0);
    this.status = init?.status ?? 200;
    this.statusText = init?.statusText ?? "";
    this.headers = new HeadersImpl(init?.headers);
    this.url = init?.url ?? "";
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  get body() {
    const bytes = this.bytes;
    let done = false;
    return {
      getReader: () => ({
        read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: bytes })),
        cancel: async () => undefined,
        releaseLock() {},
      }),
      [Symbol.asyncIterator]: async function* () { yield bytes; },
    };
  }
  private use() {
    if (this.bodyUsed) throw new TypeError("Body has already been consumed.");
    this.bodyUsed = true;
    return this.bytes;
  }
  async text() { return utf8Decode(this.use()); }
  async json() { return JSON.parse(utf8Decode(this.use())); }
  async arrayBuffer() { return this.use().slice().buffer; }
  async blob() { return new BlobImpl([this.use()], { type: this.headers.get("content-type") ?? "" }); }
  async formData() { throw new TypeError("Response.formData is not supported"); }
  clone() { return new ResponseImpl(this.bytes, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
  static json(data: any, init?: any) { return new ResponseImpl(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); }
  static error() { return new ResponseImpl("", { status: 0 }); }
}
class RequestImpl {
  readonly url: string;
  readonly method: string;
  readonly headers: HeadersImpl;
  readonly body: any;
  readonly signal: any;
  readonly redirect: string;
  constructor(input: any, init?: any) {
    const base = input instanceof RequestImpl ? input : null;
    this.url = base ? base.url : String(input instanceof URLImpl ? input.href : input);
    this.method = String(init?.method ?? base?.method ?? "GET").toUpperCase();
    this.headers = new HeadersImpl(init?.headers ?? base?.headers);
    this.body = init?.body ?? base?.body ?? null;
    this.signal = init?.signal ?? base?.signal ?? null;
    this.redirect = init?.redirect ?? base?.redirect ?? "follow";
  }
  clone() { return new RequestImpl(this); }
}
G.Response = ResponseImpl;
G.Request = RequestImpl;
let fetchSeq = 0;
const fetches = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
G.fetch = (input: any, init?: any): Promise<ResponseImpl> => {
  const req = new RequestImpl(input, init);
  return new Promise(async (resolve, reject) => {
    const signal = req.signal as AbortSignalImpl | null;
    if (signal?.aborted) return reject(signal.reason);
    let body: Uint8Array | null;
    try {
      body = await bodyBytes(req.body);
    } catch (e) {
      return reject(e);
    }
    const headers: Array<[string, string]> = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    if (body && typeof req.body === "string" && !req.headers.has("content-type")) headers.push(["content-type", "text/plain;charset=UTF-8"]);
    if (body && req.body instanceof URLSearchParamsImpl && !req.headers.has("content-type")) headers.push(["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]);
    const id = ++fetchSeq;
    fetches.set(id, { resolve, reject });
    if (signal) {
      signal.addEventListener("abort", () => {
        if (!fetches.has(id)) return;
        fetches.delete(id);
        N.fetchAbort(id);
        reject(signal.reason);
      }, { once: true });
    }
    N.fetch(id, req.url, req.method, JSON.stringify(headers), body ? bytesToB64(body) : null, req.redirect);
  });
};
function fetchDone(id: number, r: any) {
  const p = fetches.get(id);
  if (!p) return;
  fetches.delete(id);
  if (r.error) return p.reject(new TypeError(`fetch failed: ${r.error}`));
  p.resolve(new ResponseImpl(b64ToBytes(r.body ?? ""), { status: r.status, statusText: r.statusText, headers: r.headers, url: r.url }));
}

// ---------------------------------------------------------------------------------------------
// Node built-ins
// ---------------------------------------------------------------------------------------------
class EventEmitter {
  static defaultMaxListeners = 10;
  private _ev = new Map<string | symbol, Array<{ fn: any; once: boolean }>>();
  on(e: string | symbol, fn: any) { this._ev.set(e, [...(this._ev.get(e) ?? []), { fn, once: false }]); return this; }
  addListener(e: string | symbol, fn: any) { return this.on(e, fn); }
  prependListener(e: string | symbol, fn: any) { this._ev.set(e, [{ fn, once: false }, ...(this._ev.get(e) ?? [])]); return this; }
  once(e: string | symbol, fn: any) { this._ev.set(e, [...(this._ev.get(e) ?? []), { fn, once: true }]); return this; }
  off(e: string | symbol, fn: any) { this._ev.set(e, (this._ev.get(e) ?? []).filter((l) => l.fn !== fn)); return this; }
  removeListener(e: string | symbol, fn: any) { return this.off(e, fn); }
  removeAllListeners(e?: string | symbol) { if (e === undefined) this._ev.clear(); else this._ev.delete(e); return this; }
  emit(e: string | symbol, ...args: any[]) {
    const list = this._ev.get(e) ?? [];
    if (!list.length && e === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
    this._ev.set(e, list.filter((l) => !l.once));
    for (const l of list) l.fn.apply(this, args);
    return list.length > 0;
  }
  listeners(e: string | symbol) { return (this._ev.get(e) ?? []).map((l) => l.fn); }
  listenerCount(e: string | symbol) { return (this._ev.get(e) ?? []).length; }
  eventNames() { return [...this._ev.keys()]; }
  setMaxListeners() { return this; }
  getMaxListeners() { return 10; }
}
const eventsModule: any = EventEmitter;
eventsModule.EventEmitter = EventEmitter;
eventsModule.default = EventEmitter;
eventsModule.once = (em: EventEmitter, name: string) => new Promise((res) => em.once(name, (...a: any[]) => res(a)));

// --- path (posix) ---
function normalizeArray(parts: string[], allowAbove: boolean) {
  const res: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (res.length && res[res.length - 1] !== "..") res.pop();
      else if (allowAbove) res.push("..");
    } else res.push(p);
  }
  return res;
}
const path: any = {
  sep: "/",
  delimiter: ":",
  normalize(p: string) {
    const abs = p.startsWith("/");
    const trail = p.endsWith("/");
    let out = normalizeArray(p.split("/"), !abs).join("/");
    if (!out && !abs) out = ".";
    if (out && trail) out += "/";
    return (abs ? "/" : "") + out;
  },
  join(...parts: string[]) {
    const j = parts.filter((x) => typeof x === "string" && x !== "").join("/");
    return j ? path.normalize(j) : ".";
  },
  resolve(...parts: string[]) {
    let r = "";
    for (let i = parts.length - 1; i >= 0 && !r.startsWith("/"); i--) if (parts[i]) r = r ? `${parts[i]}/${r}` : parts[i];
    if (!r.startsWith("/")) r = `${processObj.cwd()}/${r}`;
    const out = "/" + normalizeArray(r.split("/"), false).join("/");
    return out;
  },
  isAbsolute: (p: string) => String(p).startsWith("/"),
  dirname(p: string) {
    if (!p) return ".";
    const s = p.replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    if (i < 0) return ".";
    if (i === 0) return "/";
    return s.slice(0, i);
  },
  basename(p: string, ext?: string) {
    const s = String(p).replace(/\/+$/, "");
    let b = s.slice(s.lastIndexOf("/") + 1);
    if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
    return b;
  },
  extname(p: string) {
    const b = path.basename(p);
    const i = b.lastIndexOf(".");
    return i <= 0 ? "" : b.slice(i);
  },
  relative(from: string, to: string) {
    const a = path.resolve(from).split("/").filter(Boolean);
    const b = path.resolve(to).split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  },
  parse(p: string) {
    const base = path.basename(p);
    const ext = path.extname(p);
    return { root: p.startsWith("/") ? "/" : "", dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
  format(o: any) { return `${o.dir ?? o.root ?? ""}${o.dir ? "/" : ""}${o.base ?? `${o.name ?? ""}${o.ext ?? ""}`}`; },
  toNamespacedPath: (p: string) => p,
};
path.posix = path;
path.default = path;

// --- process ---
const env: Record<string, string> = N.env() ?? {};
const processEvents = new EventEmitter();
const processObj: any = {
  env,
  platform: "darwin",
  arch: N.arch(),
  version: "v20.11.0",
  versions: { node: "20.11.0", glide: "native" },
  release: { name: "node" },
  argv: ["/usr/local/bin/node", "glide-extension"],
  execArgv: [],
  execPath: "/usr/local/bin/node",
  pid: N.pid(),
  ppid: 0,
  title: "glide-extension",
  exitCode: undefined,
  cwd: () => env.__GLIDE_CWD || "/",
  chdir() {},
  umask: () => 0o22,
  uptime: () => (N.monotonic() - t0) / 1000,
  hrtime: Object.assign((prev?: [number, number]) => {
    const ns = Math.round(N.monotonic() * 1e6);
    const s = Math.floor(ns / 1e9);
    const n = ns % 1e9;
    if (!prev) return [s, n];
    let ds = s - prev[0];
    let dn = n - prev[1];
    if (dn < 0) (ds -= 1), (dn += 1e9);
    return [ds, dn];
  }, { bigint: () => BigInt(Math.round(N.monotonic() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  nextTick: (fn: (...a: any[]) => void, ...args: any[]) => G.queueMicrotask(() => fn(...args)),
  emitWarning: (w: unknown) => N.log("warn", fmt(w)),
  exit: (code?: number) => {
    N.post(JSON.stringify({ type: "done" }));
    throw Object.assign(new Error(`process.exit(${code ?? 0})`), { __glideExit: true });
  },
  abort: () => processObj.exit(1),
  on: (e: string, fn: any) => (processEvents.on(e, fn), processObj),
  once: (e: string, fn: any) => (processEvents.once(e, fn), processObj),
  off: (e: string, fn: any) => (processEvents.off(e, fn), processObj),
  removeListener: (e: string, fn: any) => (processEvents.off(e, fn), processObj),
  removeAllListeners: () => processObj,
  emit: (e: string, ...a: any[]) => processEvents.emit(e, ...a),
  listeners: (e: string) => processEvents.listeners(e),
  stdout: { write: (s: string) => (N.log("log", String(s)), true), isTTY: false },
  stderr: { write: (s: string) => (N.log("error", String(s)), true), isTTY: false },
  stdin: { isTTY: false, on() {} },
  features: {},
  config: { variables: {} },
};
G.process = processObj;
G.global = G;
G.self = G;

function reportUncaught(e: any) {
  if (e && e.__glideExit) return;
  if (processEvents.listenerCount("uncaughtException")) processEvents.emit("uncaughtException", e);
  else N.log("error", `Uncaught ${fmt(e)}`);
}

// --- os ---
const os: any = {
  EOL: "\n",
  platform: () => "darwin",
  type: () => "Darwin",
  arch: () => N.arch(),
  release: () => N.osRelease(),
  homedir: () => env.HOME ?? "/",
  tmpdir: () => (env.TMPDIR ?? "/tmp").replace(/\/$/, ""),
  hostname: () => N.hostname(),
  userInfo: () => ({ username: env.USER ?? "", homedir: env.HOME ?? "/", shell: env.SHELL ?? "/bin/zsh", uid: -1, gid: -1 }),
  cpus: () => [],
  totalmem: () => 0,
  freemem: () => 0,
  uptime: () => 0,
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  endianness: () => "LE",
  constants: { signals: {}, errno: {} },
};
os.default = os;

// --- fs ---
function fsError(r: any, syscall: string, p: string) {
  const e: any = new Error(`${r.code ?? "EIO"}: ${r.error ?? "error"}, ${syscall} '${p}'`);
  e.code = r.code ?? "EIO";
  e.syscall = syscall;
  e.path = p;
  e.errno = r.errno ?? -1;
  return e;
}
const toPath = (p: any) => {
  const s = p instanceof URLImpl ? decodeURIComponent(p.pathname) : String(p);
  return s.startsWith("file://") ? decodeURIComponent(s.slice(7)) : s;
};
const encOf = (o: any): string | undefined => (typeof o === "string" ? o : o?.encoding ?? undefined);
class Stats {
  constructor(private r: any) {}
  get size() { return this.r.size; }
  get mode() { return this.r.mode; }
  get mtimeMs() { return this.r.mtimeMs; }
  get mtime() { return new Date(this.r.mtimeMs); }
  get ctime() { return new Date(this.r.mtimeMs); }
  get birthtime() { return new Date(this.r.birthtimeMs ?? this.r.mtimeMs); }
  get atime() { return new Date(this.r.mtimeMs); }
  isFile() { return this.r.type === "file"; }
  isDirectory() { return this.r.type === "dir"; }
  isSymbolicLink() { return this.r.type === "link"; }
  isFIFO() { return false; }
  isSocket() { return false; }
}
const fs: any = {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0 },
  existsSync: (p: any) => !!N.fsExists(toPath(p)),
  readFileSync(p: any, opts?: any) {
    const file = toPath(p);
    const enc = encOf(opts);
    const r = N.fsRead(file);
    if (r.error) throw fsError(r, "open", file);
    const b = BufferImpl.wrap(b64ToBytes(r.data));
    return enc ? b.toString(enc) : b;
  },
  writeFileSync(p: any, data: any, opts?: any) {
    const file = toPath(p);
    const bytes = typeof data === "string" ? encodeString(data, encOf(opts)) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    const r = N.fsWrite(file, bytesToB64(bytes), !!(opts && (opts.flag === "a" || opts.flag === "a+")), opts?.mode ?? -1);
    if (r.error) throw fsError(r, "open", file);
  },
  appendFileSync(p: any, data: any, opts?: any) { fs.writeFileSync(p, data, { ...(typeof opts === "object" ? opts : { encoding: opts }), flag: "a" }); },
  mkdirSync(p: any, opts?: any) {
    const r = N.fsMkdir(toPath(p), !!(opts === true || opts?.recursive));
    if (r.error) throw fsError(r, "mkdir", toPath(p));
    return r.created ?? undefined;
  },
  readdirSync(p: any, opts?: any) {
    const dir = toPath(p);
    const r = N.fsReaddir(dir);
    if (r.error) throw fsError(r, "scandir", dir);
    const names: string[] = r.names;
    if (opts?.withFileTypes)
      return names.map((name) => {
        const st = new Stats(N.fsStat(`${dir}/${name}`, false));
        return { name, parentPath: dir, path: dir, isFile: () => st.isFile(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
      });
    return names;
  },
  statSync(p: any, opts?: any) {
    const r = N.fsStat(toPath(p), true);
    if (r.error) {
      if (opts?.throwIfNoEntry === false) return undefined;
      throw fsError(r, "stat", toPath(p));
    }
    return new Stats(r);
  },
  lstatSync(p: any) {
    const r = N.fsStat(toPath(p), false);
    if (r.error) throw fsError(r, "lstat", toPath(p));
    return new Stats(r);
  },
  rmSync(p: any, opts?: any) {
    const r = N.fsRm(toPath(p), !!opts?.recursive, !!opts?.force);
    if (r.error) throw fsError(r, "rm", toPath(p));
  },
  rmdirSync(p: any, opts?: any) { fs.rmSync(p, { recursive: !!opts?.recursive }); },
  unlinkSync(p: any) { fs.rmSync(p, {}); },
  renameSync(a: any, b: any) {
    const r = N.fsRename(toPath(a), toPath(b));
    if (r.error) throw fsError(r, "rename", toPath(a));
  },
  copyFileSync(a: any, b: any) {
    const r = N.fsCopy(toPath(a), toPath(b));
    if (r.error) throw fsError(r, "copyfile", toPath(a));
  },
  accessSync(p: any) { if (!N.fsExists(toPath(p))) throw fsError({ code: "ENOENT", error: "no such file or directory" }, "access", toPath(p)); },
  realpathSync: Object.assign((p: any) => N.fsRealpath(toPath(p)) ?? toPath(p), { native: (p: any) => N.fsRealpath(toPath(p)) ?? toPath(p) }),
  mkdtempSync(prefix: string) {
    const p = `${prefix}${randomBytes(4).toString("hex")}`;
    fs.mkdirSync(p, { recursive: true });
    return p;
  },
  chmodSync() {},
  watch() { throw new Error('fs.watch is not supported by Glide\'s native extension runtime'); },
  createReadStream() { throw new Error("fs.createReadStream is not supported by Glide's native extension runtime (use fs.readFileSync)"); },
  createWriteStream() { throw new Error("fs.createWriteStream is not supported by Glide's native extension runtime (use fs.writeFileSync)"); },
};
const promisifyFs = (name: string) => (...a: any[]) => new Promise((res, rej) => {
  try {
    res(fs[`${name}Sync`](...a));
  } catch (e) {
    rej(e);
  }
});
const fsNames = ["readFile", "writeFile", "appendFile", "mkdir", "readdir", "stat", "lstat", "rm", "rmdir", "unlink", "rename", "copyFile", "access", "realpath", "mkdtemp", "chmod"];
fs.promises = Object.fromEntries(fsNames.map((n) => [n, promisifyFs(n)]));
fs.promises.constants = fs.constants;
for (const n of fsNames)
  fs[n] = (...a: any[]) => {
    const cb = typeof a[a.length - 1] === "function" ? a.pop() : null;
    let out: any;
    let err: any = null;
    try {
      out = fs[`${n}Sync`](...a);
    } catch (e) {
      err = e;
    }
    if (cb) G.queueMicrotask(() => cb(err, out));
  };
fs.exists = (p: any, cb: (b: boolean) => void) => G.queueMicrotask(() => cb(fs.existsSync(p)));
fs.default = fs;

// --- crypto ---
const ALG: Record<string, string> = { sha1: "sha1", sha256: "sha256", sha384: "sha384", sha512: "sha512", md5: "md5", "sha-1": "sha1", "sha-256": "sha256", "sha-512": "sha512" };
class Hash {
  private parts: Uint8Array[] = [];
  constructor(private alg: string, private key: Uint8Array | null = null) {
    if (!ALG[alg.toLowerCase()]) throw new Error(`Digest method not supported: ${alg}`);
  }
  update(d: any, enc?: string) {
    this.parts.push(typeof d === "string" ? encodeString(d, enc) : new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength));
    return this;
  }
  digest(enc?: string) {
    const data = bytesToB64(BufferImpl.concat(this.parts));
    const out = this.key ? N.hmac(ALG[this.alg.toLowerCase()], bytesToB64(this.key), data) : N.digest(ALG[this.alg.toLowerCase()], data);
    const b = BufferImpl.wrap(b64ToBytes(out));
    return enc ? b.toString(enc) : b;
  }
  copy() {
    const h = new Hash(this.alg, this.key);
    h.parts = [...this.parts];
    return h;
  }
}
const cryptoModule: any = {
  randomBytes: (n: number, cb?: any) => {
    const b = randomBytes(n);
    if (cb) G.queueMicrotask(() => cb(null, b));
    return b;
  },
  randomUUID,
  randomInt: (a: number, b?: number) => {
    const [min, max] = b === undefined ? [0, a] : [a, b];
    return min + (randomBytes(4).readUInt32BE(0) % (max - min));
  },
  createHash: (alg: string) => new Hash(alg),
  createHmac: (alg: string, key: any) => new Hash(alg, typeof key === "string" ? utf8Encode(key) : new Uint8Array(key)),
  getRandomValues: (a: any) => G.crypto.getRandomValues(a),
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]),
  webcrypto: G.crypto,
  getHashes: () => Object.keys(ALG),
  createCipheriv() { throw new Error("crypto ciphers are not supported by Glide's native extension runtime"); },
  createDecipheriv() { throw new Error("crypto ciphers are not supported by Glide's native extension runtime"); },
};
cryptoModule.default = cryptoModule;

// --- util ---
const util: any = {
  promisify(fn: any) {
    if (fn && fn[Symbol.for("nodejs.util.promisify.custom")]) return fn[Symbol.for("nodejs.util.promisify.custom")];
    return (...a: any[]) => new Promise((res, rej) => fn(...a, (err: any, ...v: any[]) => (err ? rej(err) : res(v.length > 1 ? v : v[0]))));
  },
  callbackify: (fn: any) => (...a: any[]) => {
    const cb = a.pop();
    fn(...a).then((v: any) => cb(null, v), (e: any) => cb(e));
  },
  inspect: (v: any) => fmt(v),
  format: (...a: any[]) => format(a),
  inherits(ctor: any, sup: any) {
    Object.setPrototypeOf(ctor.prototype, sup.prototype);
    Object.setPrototypeOf(ctor, sup);
  },
  deprecate: (fn: any) => fn,
  isDeepStrictEqual: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b),
  types: { isPromise: (v: any) => v instanceof Promise, isDate: (v: any) => v instanceof Date, isRegExp: (v: any) => v instanceof RegExp },
  TextEncoder: TextEncoderImpl,
  TextDecoder: TextDecoderImpl,
  isArray: Array.isArray,
  debuglog: () => () => undefined,
};
util.inspect.custom = Symbol.for("nodejs.util.inspect.custom");
util.default = util;

// --- child_process (limited: execFile/exec, run natively; spawn unsupported) ---
let execSeq = 0;
const execs = new Map<number, (r: any) => void>();
function execNative(file: string, args: string[], opts: any, input: string | null, cb: (err: any, stdout: string, stderr: string) => void) {
  const id = ++execSeq;
  execs.set(id, (r) => {
    if (r.error || r.code !== 0) {
      const e: any = new Error(r.error ?? `Command failed: ${[file, ...args].join(" ")}\n${r.stderr ?? ""}`);
      e.code = r.code;
      e.killed = !!r.killed;
      e.stdout = r.stdout;
      e.stderr = r.stderr;
      cb(e, r.stdout ?? "", r.stderr ?? "");
    } else cb(null, r.stdout ?? "", r.stderr ?? "");
  });
  N.exec(id, String(file), JSON.stringify(args.map(String)), JSON.stringify({ cwd: opts?.cwd ?? null, timeout: opts?.timeout ?? 0, env: opts?.env ?? null }), input);
}
function childHandle(start: (input: string | null) => void) {
  const child: any = new EventEmitter();
  let input: string | null = null;
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    start(input);
  };
  child.stdin = { write: (s: any) => ((input = (input ?? "") + String(s)), true), end: (s?: any) => { if (s !== undefined) input = (input ?? "") + String(s); go(); } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => false;
  child.pid = undefined;
  G.setTimeout(go, 0);
  return child;
}
const childProcess: any = {
  execFile(file: string, a?: any, b?: any, c?: any) {
    const args = Array.isArray(a) ? a : [];
    const opts = Array.isArray(a) ? (typeof b === "object" ? b : {}) : typeof a === "object" ? a : {};
    const cb = [a, b, c].find((x) => typeof x === "function") ?? (() => undefined);
    return childHandle((input) => execNative(file, args, opts, input, cb));
  },
  exec(cmd: string, a?: any, b?: any) {
    const opts = typeof a === "object" ? a : {};
    const cb = [a, b].find((x) => typeof x === "function") ?? (() => undefined);
    return childHandle((input) => execNative(opts.shell || "/bin/sh", ["-c", cmd], opts, input, cb));
  },
  spawn() { throw new Error("child_process.spawn is not supported by Glide's native extension runtime (execFile/exec are)"); },
  fork() { throw new Error("child_process.fork is not supported by Glide's native extension runtime"); },
  execSync() { throw new Error("child_process.execSync is not supported by Glide's native extension runtime (use execFile)"); },
  execFileSync() { throw new Error("child_process.execFileSync is not supported by Glide's native extension runtime (use execFile)"); },
  spawnSync() { throw new Error("child_process.spawnSync is not supported by Glide's native extension runtime"); },
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file: string, args?: string[], opts?: any) =>
  new Promise((res, rej) => childProcess.execFile(file, args ?? [], opts ?? {}, (e: any, stdout: string, stderr: string) => (e ? rej(e) : res({ stdout, stderr }))));
childProcess.exec[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, opts?: any) =>
  new Promise((res, rej) => childProcess.exec(cmd, opts ?? {}, (e: any, stdout: string, stderr: string) => (e ? rej(e) : res({ stdout, stderr }))));
function execDone(id: number, r: any) {
  const cb = execs.get(id);
  execs.delete(id);
  cb?.(r);
}

const querystring: any = {
  stringify: (o: any) => new URLSearchParamsImpl(o).toString(),
  parse: (s: string) => {
    const out: Record<string, any> = {};
    new URLSearchParamsImpl(s).forEach((v, k) => (out[k] = k in out ? [].concat(out[k], v as any) : v));
    return out;
  },
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
};
const urlModule: any = {
  URL: URLImpl,
  URLSearchParams: URLSearchParamsImpl,
  fileURLToPath: (u: any) => decodeURIComponent(new URLImpl(String(u)).pathname),
  pathToFileURL: (p: string) => new URLImpl(`file://${encodeURI(path.resolve(p))}`),
  parse: (s: string) => {
    const u = new URLImpl(s);
    return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, query: u.search.slice(1) };
  },
  format: (u: any) => (u instanceof URLImpl ? u.href : String(u?.href ?? "")),
};
const timersModule: any = { setTimeout: G.setTimeout, clearTimeout: G.clearTimeout, setInterval: G.setInterval, clearInterval: G.clearInterval, setImmediate: G.setImmediate, clearImmediate: G.clearImmediate };
timersModule.promises = { setTimeout: (ms: number, v?: any) => new Promise((r) => G.setTimeout(() => r(v), ms)), setImmediate: (v?: any) => new Promise((r) => G.setImmediate(() => r(v))) };
const assertFn: any = (c: any, m?: string) => { if (!c) throw new Error(m ?? "Assertion failed"); };
assertFn.ok = assertFn;
assertFn.equal = (a: any, b: any, m?: string) => assertFn(a == b, m); // eslint-disable-line eqeqeq
assertFn.strictEqual = (a: any, b: any, m?: string) => assertFn(a === b, m ?? `${fmt(a)} !== ${fmt(b)}`);
assertFn.deepStrictEqual = (a: any, b: any, m?: string) => assertFn(JSON.stringify(a) === JSON.stringify(b), m);
assertFn.notStrictEqual = (a: any, b: any, m?: string) => assertFn(a !== b, m);
assertFn.fail = (m?: string) => assertFn(false, m);
const stringDecoder = { StringDecoder: class { constructor(private enc = "utf8") {} write(b: Uint8Array) { return BufferImpl.wrap(b).toString(this.enc); } end(b?: Uint8Array) { return b ? this.write(b) : ""; } } };

const unsupported = (name: string) => () => {
  throw new Error(`Node built-in "${name}" is not supported by Glide's native extension runtime${name === "http" || name === "https" ? " (use fetch)" : ""}`);
};
const BUILTINS: Record<string, () => any> = {
  fs: () => fs,
  "fs/promises": () => fs.promises,
  path: () => path,
  "path/posix": () => path,
  os: () => os,
  crypto: () => cryptoModule,
  events: () => eventsModule,
  util: () => util,
  buffer: () => ({ Buffer: BufferImpl, Blob: BlobImpl, atob: G.atob, btoa: G.btoa, constants: { MAX_LENGTH: 2 ** 31 - 1 } }),
  url: () => urlModule,
  querystring: () => querystring,
  child_process: () => childProcess,
  timers: () => timersModule,
  "timers/promises": () => timersModule.promises,
  assert: () => assertFn,
  string_decoder: () => stringDecoder,
  process: () => processObj,
  module: () => Module,
  perf_hooks: () => ({ performance: G.performance }),
};
for (const n of ["http", "https", "http2", "net", "tls", "dgram", "dns", "zlib", "stream", "worker_threads", "cluster", "vm", "readline", "tty", "v8", "inspector", "async_hooks", "sqlite"]) BUILTINS[n] = unsupported(n);
const builtinCache = new Map<string, any>();
const builtinName = (id: string) => (id.startsWith("node:") ? id.slice(5) : id);
const isBuiltin = (id: string) => Object.prototype.hasOwnProperty.call(BUILTINS, builtinName(id));
function loadBuiltin(id: string) {
  const n = builtinName(id);
  if (!builtinCache.has(n)) builtinCache.set(n, BUILTINS[n]());
  return builtinCache.get(n);
}

// ---------------------------------------------------------------------------------------------
// CommonJS loader (Node-compatible enough for the runtimes' _resolveFilename hooks)
// ---------------------------------------------------------------------------------------------
const VIRTUAL_DIR = "/__glide__";
const virtualFiles = new Map<string, string>();
virtualFiles.set(`${VIRTUAL_DIR}/glide-api.cjs`, API_SHIM_SOURCE);
for (const [k, v] of Object.entries(RAYCAST_SHIMS)) virtualFiles.set(`${VIRTUAL_DIR}/${k}`, v);
const isFile = (p: string) => virtualFiles.has(p) || N.fsStat(p, true).type === "file";
const isDir = (p: string) => N.fsStat(p, true).type === "dir";

class Module {
  static _cache: Record<string, Module> = Object.create(null);
  static builtinModules = Object.keys(BUILTINS);
  static isBuiltin = isBuiltin;
  static _extensions: Record<string, unknown> = { ".js": true, ".cjs": true, ".json": true };
  static createRequire = (filename: string) => {
    const m = new Module(filename, null);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    return makeRequire(m);
  };
  static _nodeModulePaths(from: string): string[] {
    const out: string[] = [];
    let dir = path.resolve(from);
    for (;;) {
      if (!dir.endsWith("/node_modules")) out.push(`${dir === "/" ? "" : dir}/node_modules`);
      if (dir === "/") break;
      dir = path.dirname(dir);
    }
    return out;
  }
  static _resolveFilename(request: string, parent: Module | null): string {
    if (isBuiltin(request)) return request;
    const base = parent?.filename ? path.dirname(parent.filename) : processObj.cwd();
    if (request.startsWith("./") || request.startsWith("../") || request.startsWith("/") || request === "." || request === "..") {
      const abs = request.startsWith("/") ? path.normalize(request) : path.resolve(base, request);
      const hit = tryFile(abs) ?? tryDir(abs);
      if (hit) return hit;
    } else {
      for (const nm of Module._nodeModulePaths(base)) {
        const hit = tryPackage(nm, request);
        if (hit) return hit;
      }
    }
    const err: any = new Error(`Cannot find module '${request}'${parent?.filename ? `\nRequire stack:\n- ${parent.filename}` : ""}`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  static _load(request: string, parent: Module | null) {
    if (isBuiltin(request)) return loadBuiltin(request);
    const filename = Module._resolveFilename(request, parent);
    if (isBuiltin(filename)) return loadBuiltin(filename);
    const cached = Module._cache[filename];
    if (cached) return cached.exports;
    const m = new Module(filename, parent);
    Module._cache[filename] = m;
    try {
      m.load(filename);
    } catch (e) {
      delete Module._cache[filename];
      throw e;
    }
    return m.exports;
  }
  id: string;
  filename = "";
  loaded = false;
  exports: any = {};
  children: Module[] = [];
  paths: string[] = [];
  constructor(id: string, readonly parent: Module | null) {
    this.id = id;
  }
  require(id: string) { return Module._load(id, this); }
  load(filename: string) {
    this.filename = filename;
    this.paths = Module._nodeModulePaths(path.dirname(filename));
    const source = virtualFiles.get(filename) ?? fs.readFileSync(filename, "utf8");
    if (filename.endsWith(".json")) {
      this.exports = JSON.parse(source);
    } else {
      const body = source.startsWith("#!") ? `//${source}` : source;
      const fn = N.evaluate(`(function (exports, require, module, __filename, __dirname) {${body}\n})`, filename);
      fn.call(this.exports, this.exports, makeRequire(this), this, filename, path.dirname(filename));
    }
    this.loaded = true;
  }
}
function makeRequire(m: Module) {
  const req: any = (id: string) => Module._load(String(id), m);
  req.resolve = (id: string) => Module._resolveFilename(String(id), m);
  req.cache = Module._cache;
  req.main = undefined;
  return req;
}
function tryFile(p: string): string | null {
  for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.json`]) if (isFile(c)) return c;
  return null;
}
function tryDir(p: string): string | null {
  if (!isDir(p)) return null;
  const pkgFile = `${p}/package.json`;
  if (isFile(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      const exp = pkg.exports;
      const main = typeof exp === "string" ? exp : exp?.["."] ? pickExport(exp["."]) : pickExport(exp) ?? pkg.main;
      if (main) {
        const hit = tryFile(path.resolve(p, main)) ?? tryDir(path.resolve(p, main));
        if (hit) return hit;
      }
    } catch {
      /* fall through to index */
    }
  }
  return tryFile(`${p}/index`);
}
function pickExport(e: any): string | undefined {
  if (!e) return undefined;
  if (typeof e === "string") return e;
  if (Array.isArray(e)) return e.map(pickExport).find(Boolean);
  for (const k of ["require", "node", "default"]) if (e[k]) return pickExport(e[k]);
  return undefined;
}
function tryPackage(nm: string, request: string): string | null {
  const parts = request.split("/");
  const name = request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = parts.slice(request.startsWith("@") ? 2 : 1).join("/");
  const dir = `${nm}/${name}`;
  if (!isDir(dir)) return null;
  if (!sub) return tryDir(dir);
  try {
    const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
    const target = pkg.exports && typeof pkg.exports === "object" ? pickExport(pkg.exports[`./${sub}`]) : undefined;
    if (target) return tryFile(path.resolve(dir, target));
  } catch {
    /* no package.json */
  }
  return tryFile(`${dir}/${sub}`) ?? tryDir(`${dir}/${sub}`);
}
const rootRequire = makeRequire(new Module("<glide>", null));

// ---------------------------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------------------------
let listener: ((msg: any) => void) | null = null;
const port = {
  send: (m: unknown) => N.post(JSON.stringify(m)),
  onMessage: (cb: (msg: any) => void) => void (listener = cb),
};
G.__glideHost = {
  start(initJson: string) {
    const init = JSON.parse(initJson);
    init.apiPath = `${VIRTUAL_DIR}/glide-api.cjs`;
    init.shimDir = VIRTUAL_DIR;
    if (init.environment?.extensionPath) env.__GLIDE_CWD = init.environment.extensionPath;
    if (init.runtime === "raycast") raycastRuntime(rootRequire, port, { createMiniReact, createRaycastSerializer, createRaycastApi, createRaycastUtils } as any);
    else glideRuntime(rootRequire, port);
    listener?.({ type: "init", init });
  },
  receive(json: string) {
    try {
      listener?.(JSON.parse(json));
    } catch (e) {
      reportUncaught(e);
    }
  },
  timerFired,
  fetchDone: (id: number, json: string) => fetchDone(id, JSON.parse(json)),
  execDone: (id: number, json: string) => execDone(id, JSON.parse(json)),
  pendingTimers: () => timers.size,
};
