// Minimal dependency-free PNG codec + pixel differ (node:zlib only).
// Decodes 8-bit greyscale/RGB/RGBA/grey+alpha/palette, non-interlaced (what Chromium's
// Page.captureScreenshot emits); always encodes 8-bit RGBA.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @typedef {{ width: number, height: number, data: Uint8Array }} Image  RGBA, row-major */

/** @returns {Image} */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace) throw new Error("interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (colorType === 6) {
      data[o] = pixels[j]; data[o + 1] = pixels[j + 1]; data[o + 2] = pixels[j + 2]; data[o + 3] = pixels[j + 3];
    } else if (colorType === 2) {
      data[o] = pixels[j]; data[o + 1] = pixels[j + 1]; data[o + 2] = pixels[j + 2]; data[o + 3] = 255;
    } else if (colorType === 0) {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]; data[o + 3] = 255;
    } else if (colorType === 4) {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]; data[o + 3] = pixels[j + 1];
    } else {
      const p = pixels[j];
      data[o] = palette[p * 3]; data[o + 1] = palette[p * 3 + 1]; data[o + 2] = palette[p * 3 + 2];
      data[o + 3] = trns && p < trns.length ? trns[p] : 255;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode an RGBA image. Opaque images are written as RGB; each row uses whichever of the
 * five PNG filters gives the smallest absolute sum (the usual libpng heuristic).
 */
export function encodePng({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  if (opaque) for (let i = 0, j = 0; i < data.length; i += 4, j += 3) (px[j] = data[i]), (px[j + 1] = data[i + 1]), (px[j + 2] = data[i + 2]);
  else px.set(data);
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? cur[x - ch] : 0, b = up[x], c = x >= ch ? up[x - ch] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[x] - pred) & 0xff;
        out[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) (bestSum = sum), (best = f);
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Box-filter downscale by an integer factor (2x retina capture -> 1x baseline). */
export function downscale(img, factor) {
  if (factor <= 1) return img;
  const width = Math.floor(img.width / factor), height = Math.floor(img.height / factor);
  const data = new Uint8Array(width * height * 4);
  const n = factor * factor;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++)
          for (let dx = 0; dx < factor; dx++) sum += img.data[((y * factor + dy) * img.width + x * factor + dx) * 4 + c];
        data[(y * width + x) * 4 + c] = Math.round(sum / n);
      }
  return { width, height, data };
}

/** Paint rectangles (CSS px in image space) a flat magenta so dynamic regions never diff. */
export function maskRects(img, rects, rgba = [255, 0, 255, 255]) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(img.width, Math.ceil(r.x + r.width)), y1 = Math.min(img.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) img.data.set(rgba, (y * img.width + x) * 4);
  }
  return img;
}

/**
 * Compare two images. A pixel differs when any channel (alpha-premultiplied against black)
 * differs by more than `threshold` (0-255). Size mismatches count every pixel of the
 * non-overlapping area as different.
 * @returns {{ diffPixels: number, total: number, ratio: number, sizeMismatch: boolean, diff: Image }}
 */
export function diffImages(a, b, { threshold = 24 } = {}) {
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const diff = { width, height, data: new Uint8Array(width * height * 4) };
  let diffPixels = 0;
  const px = (img, x, y, c) => {
    const o = (y * img.width + x) * 4;
    return c === 3 ? img.data[o + 3] : (img.data[o + c] * img.data[o + 3]) / 255;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inside = x < a.width && y < a.height && x < b.width && y < b.height;
      let different = !inside;
      if (inside) for (let c = 0; c < 4 && !different; c++) different = Math.abs(px(a, x, y, c) - px(b, x, y, c)) > threshold;
      if (different) {
        diffPixels++;
        diff.data.set([255, 0, 64, 255], o);
      } else if (inside) {
        // Faded copy of the baseline so the red pixels have context.
        const g = Math.round((a.data[o] + a.data[o + 1] + a.data[o + 2]) / 3 / 4 + 160);
        diff.data.set([g, g, g, 255], o);
      }
    }
  const total = width * height;
  return { diffPixels, total, ratio: total ? diffPixels / total : 0, sizeMismatch: a.width !== b.width || a.height !== b.height, diff };
}
