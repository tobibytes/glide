// Glide Remote crypto: ChaCha20-Poly1305 AEAD (RFC 8439) and base64url, written for Glide.
// The page is served over plain http on the local network, an insecure context where crypto.subtle does not
// exist, so the cipher lives here. Randomness comes from crypto.getRandomValues, which insecure pages can use.
// Works in the browser (window.GlideCrypto) and in Node (module.exports) for the RFC test vectors.
(function (root) {
  'use strict';

  // ---------- ChaCha20 ----------

  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }

  function u32le(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

  // One 64-byte keystream block for (key words, counter, nonce words) into out.
  function chachaBlock(k, counter, n, out) {
    const s = new Uint32Array(16);
    s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) s[4 + i] = k[i];
    s[12] = counter >>> 0;
    s[13] = n[0]; s[14] = n[1]; s[15] = n[2];
    let x0 = s[0], x1 = s[1], x2 = s[2], x3 = s[3], x4 = s[4], x5 = s[5], x6 = s[6], x7 = s[7];
    let x8 = s[8], x9 = s[9], x10 = s[10], x11 = s[11], x12 = s[12], x13 = s[13], x14 = s[14], x15 = s[15];
    for (let r = 0; r < 10; r++) {
      // column rounds
      x0 = (x0 + x4) | 0; x12 = rotl(x12 ^ x0, 16); x8 = (x8 + x12) | 0; x4 = rotl(x4 ^ x8, 12);
      x0 = (x0 + x4) | 0; x12 = rotl(x12 ^ x0, 8); x8 = (x8 + x12) | 0; x4 = rotl(x4 ^ x8, 7);
      x1 = (x1 + x5) | 0; x13 = rotl(x13 ^ x1, 16); x9 = (x9 + x13) | 0; x5 = rotl(x5 ^ x9, 12);
      x1 = (x1 + x5) | 0; x13 = rotl(x13 ^ x1, 8); x9 = (x9 + x13) | 0; x5 = rotl(x5 ^ x9, 7);
      x2 = (x2 + x6) | 0; x14 = rotl(x14 ^ x2, 16); x10 = (x10 + x14) | 0; x6 = rotl(x6 ^ x10, 12);
      x2 = (x2 + x6) | 0; x14 = rotl(x14 ^ x2, 8); x10 = (x10 + x14) | 0; x6 = rotl(x6 ^ x10, 7);
      x3 = (x3 + x7) | 0; x15 = rotl(x15 ^ x3, 16); x11 = (x11 + x15) | 0; x7 = rotl(x7 ^ x11, 12);
      x3 = (x3 + x7) | 0; x15 = rotl(x15 ^ x3, 8); x11 = (x11 + x15) | 0; x7 = rotl(x7 ^ x11, 7);
      // diagonal rounds
      x0 = (x0 + x5) | 0; x15 = rotl(x15 ^ x0, 16); x10 = (x10 + x15) | 0; x5 = rotl(x5 ^ x10, 12);
      x0 = (x0 + x5) | 0; x15 = rotl(x15 ^ x0, 8); x10 = (x10 + x15) | 0; x5 = rotl(x5 ^ x10, 7);
      x1 = (x1 + x6) | 0; x12 = rotl(x12 ^ x1, 16); x11 = (x11 + x12) | 0; x6 = rotl(x6 ^ x11, 12);
      x1 = (x1 + x6) | 0; x12 = rotl(x12 ^ x1, 8); x11 = (x11 + x12) | 0; x6 = rotl(x6 ^ x11, 7);
      x2 = (x2 + x7) | 0; x13 = rotl(x13 ^ x2, 16); x8 = (x8 + x13) | 0; x7 = rotl(x7 ^ x8, 12);
      x2 = (x2 + x7) | 0; x13 = rotl(x13 ^ x2, 8); x8 = (x8 + x13) | 0; x7 = rotl(x7 ^ x8, 7);
      x3 = (x3 + x4) | 0; x14 = rotl(x14 ^ x3, 16); x9 = (x9 + x14) | 0; x4 = rotl(x4 ^ x9, 12);
      x3 = (x3 + x4) | 0; x14 = rotl(x14 ^ x3, 8); x9 = (x9 + x14) | 0; x4 = rotl(x4 ^ x9, 7);
    }
    const x = [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15];
    for (let i = 0; i < 16; i++) {
      const w = (x[i] + s[i]) >>> 0;
      out[4 * i] = w & 0xff; out[4 * i + 1] = (w >>> 8) & 0xff; out[4 * i + 2] = (w >>> 16) & 0xff; out[4 * i + 3] = w >>> 24;
    }
    return out;
  }

  function keyWords(key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('ChaCha20 key must be 32 bytes');
    const k = new Uint32Array(8);
    for (let i = 0; i < 8; i++) k[i] = u32le(key, 4 * i);
    return k;
  }

  function nonceWords(nonce) {
    if (!(nonce instanceof Uint8Array) || nonce.length !== 12) throw new Error('ChaCha20 nonce must be 12 bytes');
    return new Uint32Array([u32le(nonce, 0), u32le(nonce, 4), u32le(nonce, 8)]);
  }

  /** ChaCha20 block function (RFC 8439 2.3): 64 bytes of keystream. */
  function chacha20Block(key, counter, nonce) {
    return chachaBlock(keyWords(key), counter, nonceWords(nonce), new Uint8Array(64));
  }

  /** ChaCha20 encryption (RFC 8439 2.4): XOR data with the keystream starting at `counter`. */
  function chacha20(key, counter, nonce, data) {
    const k = keyWords(key), n = nonceWords(nonce);
    const out = new Uint8Array(data.length);
    const ks = new Uint8Array(64);
    let ctr = counter >>> 0;
    for (let off = 0; off < data.length; off += 64) {
      chachaBlock(k, ctr, n, ks);
      ctr = (ctr + 1) >>> 0;
      const end = Math.min(64, data.length - off);
      for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return out;
  }

  // ---------- Poly1305 ----------
  // The accumulator and r are kept as ten 13-bit limbs in plain JS numbers. Every product is below 2^30 and a
  // row of ten of them stays below 2^34, so the arithmetic is exact in doubles (no 32-bit truncation).

  function limbs(b, off, hibit, out) {
    const t = new Array(8);
    for (let i = 0; i < 8; i++) t[i] = b[off + 2 * i] | (b[off + 2 * i + 1] << 8);
    out[0] = t[0] & 0x1fff;
    out[1] = ((t[0] >>> 13) | (t[1] << 3)) & 0x1fff;
    out[2] = ((t[1] >>> 10) | (t[2] << 6)) & 0x1fff;
    out[3] = ((t[2] >>> 7) | (t[3] << 9)) & 0x1fff;
    out[4] = ((t[3] >>> 4) | (t[4] << 12)) & 0x1fff;
    out[5] = (t[4] >>> 1) & 0x1fff;
    out[6] = ((t[4] >>> 14) | (t[5] << 2)) & 0x1fff;
    out[7] = ((t[5] >>> 11) | (t[6] << 5)) & 0x1fff;
    out[8] = ((t[6] >>> 8) | (t[7] << 8)) & 0x1fff;
    out[9] = (t[7] >>> 5) | hibit;
    return out;
  }

  /** Poly1305 one-time authenticator (RFC 8439 2.5): 16-byte tag of msg under a 32-byte one-time key. */
  function poly1305(key, msg) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Poly1305 key must be 32 bytes');
    const rb = key.slice(0, 16);
    rb[3] &= 15; rb[7] &= 15; rb[11] &= 15; rb[15] &= 15;
    rb[4] &= 252; rb[8] &= 252; rb[12] &= 252;
    const r = limbs(rb, 0, 0, new Array(10));
    const r5 = r.map(function (x) { return x * 5; });
    const h = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const m = new Array(10);
    const d = new Array(10);
    const last = new Uint8Array(16);
    for (let off = 0; off < msg.length; off += 16) {
      const left = msg.length - off;
      if (left >= 16) {
        limbs(msg, off, 1 << 11, m);
      } else {
        last.fill(0);
        last.set(msg.subarray(off, off + left));
        last[left] = 1;
        limbs(last, 0, 0, m);
      }
      for (let i = 0; i < 10; i++) h[i] += m[i];
      let c = 0;
      for (let i = 0; i < 10; i++) {
        let s = c;
        for (let j = 0; j < 10; j++) s += h[j] * (j <= i ? r[i - j] : r5[i + 10 - j]);
        c = Math.floor(s / 8192);
        d[i] = s - c * 8192;
      }
      d[0] += c * 5; // 2^130 = 5 (mod p)
      c = Math.floor(d[0] / 8192);
      d[0] -= c * 8192;
      d[1] += c;
      for (let i = 0; i < 10; i++) h[i] = d[i];
    }
    // Finish once per message with BigInt: reduce mod 2^130 - 5, add s, keep the low 128 bits.
    let acc = 0n;
    for (let i = 9; i >= 0; i--) acc = (acc << 13n) + BigInt(h[i]);
    const p = (1n << 130n) - 5n;
    acc %= p;
    let s = 0n;
    for (let i = 15; i >= 0; i--) s = (s << 8n) + BigInt(key[16 + i]);
    acc = (acc + s) & ((1n << 128n) - 1n);
    const tag = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { tag[i] = Number(acc & 0xffn); acc >>= 8n; }
    return tag;
  }

  // ---------- AEAD (RFC 8439 2.8) ----------

  function polyKey(key, nonce) { return chacha20Block(key, 0, nonce).slice(0, 32); }

  function macData(aad, ct) {
    const pad = function (n) { return (16 - (n % 16)) % 16; };
    const len = aad.length + pad(aad.length) + ct.length + pad(ct.length) + 16;
    const buf = new Uint8Array(len);
    buf.set(aad, 0);
    const ctOff = aad.length + pad(aad.length);
    buf.set(ct, ctOff);
    const lenOff = ctOff + ct.length + pad(ct.length);
    writeLen(buf, lenOff, aad.length);
    writeLen(buf, lenOff + 8, ct.length);
    return buf;
  }

  function writeLen(buf, off, n) {
    let v = n;
    for (let i = 0; i < 8; i++) { buf[off + i] = v % 256; v = Math.floor(v / 256); }
  }

  /** Encrypt: returns ciphertext || 16-byte tag. */
  function seal(key, nonce, plaintext, aad) {
    const a = aad || new Uint8Array(0);
    const ct = chacha20(key, 1, nonce, plaintext);
    const tag = poly1305(polyKey(key, nonce), macData(a, ct));
    const out = new Uint8Array(ct.length + 16);
    out.set(ct, 0);
    out.set(tag, ct.length);
    return out;
  }

  /** Decrypt ciphertext || tag. Returns the plaintext, or null when the tag does not match. */
  function open(key, nonce, sealed, aad) {
    if (!(sealed instanceof Uint8Array) || sealed.length < 16) return null;
    const a = aad || new Uint8Array(0);
    const ct = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const want = poly1305(polyKey(key, nonce), macData(a, ct));
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= want[i] ^ tag[i]; // constant time
    if (diff !== 0) return null;
    return chacha20(key, 1, nonce, ct);
  }

  // ---------- encodings ----------

  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const URL_ALPHA = ALPHA + '-_';
  const STD_ALPHA = ALPHA + '+/';
  const DECODE = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) { DECODE[URL_ALPHA.charCodeAt(i)] = i; DECODE[STD_ALPHA.charCodeAt(i)] = i; }

  function encode(bytes, alpha, padded) {
    const parts = [];
    let chunk = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      const left = bytes.length - i;
      chunk += alpha[(n >>> 18) & 63] + alpha[(n >>> 12) & 63];
      chunk += left > 1 ? alpha[(n >>> 6) & 63] : (padded ? '=' : '');
      chunk += left > 2 ? alpha[n & 63] : (padded ? '=' : '');
      if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
    }
    parts.push(chunk);
    return parts.join('');
  }

  /** base64url without padding (RFC 4648 section 5). */
  function b64url(bytes) { return encode(bytes, URL_ALPHA, false); }
  /** Standard base64 with padding. */
  function b64(bytes) { return encode(bytes, STD_ALPHA, true); }

  /** Decode base64 or base64url (padding optional, whitespace ignored). Throws on bad input. */
  function fromB64(text) {
    const s = String(text).replace(/[\s=]/g, '');
    if (s.length % 4 === 1) throw new Error('Bad base64');
    const out = new Uint8Array(Math.floor(s.length * 3 / 4));
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const v = c < 128 ? DECODE[c] : -1;
      if (v < 0) throw new Error('Bad base64');
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >>> bits) & 0xff; }
    }
    return out.subarray(0, o);
  }

  function hex(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function fromHex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
    return out;
  }

  function utf8(s) { return new TextEncoder().encode(s); }
  function fromUtf8(b) { return new TextDecoder().decode(b); }

  /** Random bytes from crypto.getRandomValues (available in insecure contexts). */
  function random(n) {
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (!c) throw new Error('No secure random source');
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) c.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
    return out;
  }

  /** Version 4 UUID from getRandomValues (crypto.randomUUID needs a secure context). */
  function uuid() {
    const b = random(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  const api = { chacha20Block, chacha20, poly1305, seal, open, b64url, b64, fromB64, hex, fromHex, utf8, fromUtf8, random, uuid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GlideCrypto = api;
})(typeof self !== 'undefined' ? self : this);
