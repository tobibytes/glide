// Glide Remote: pairing storage and the encrypted call to the Mac (docs/PHONE.md "Transport 1: LAN").
// Every call is one POST /api with {v, d, n, c}: ChaCha20-Poly1305 under the device key, AAD
// "glide-phone-v1|<deviceId>|req" (responses "…|res"), plaintext {id, ts, action, args}.
(function (root) {
  'use strict';
  const C = root.GlideCrypto;
  const STORE = 'glide.pairing';

  class GlideError extends Error {
    constructor(code, message, action) {
      super(message);
      this.code = code;
      this.action = action || '';
    }
  }

  const Pairing = {
    load() {
      try {
        const p = JSON.parse(root.localStorage.getItem(STORE) || 'null');
        if (p && typeof p.deviceId === 'string' && typeof p.key === 'string' && C.fromB64(p.key).length === 32) return p;
      } catch (e) { /* storage blocked or bad data: treat as unpaired */ }
      return null;
    },
    save(p) {
      try { root.localStorage.setItem(STORE, JSON.stringify(p)); return true; } catch (e) { return false; }
    },
    update(patch) {
      const p = Pairing.load();
      if (p) Pairing.save(Object.assign(p, patch));
    },
    clear() { try { root.localStorage.removeItem(STORE); } catch (e) { /* ignore */ } },
    /** Parse "<deviceId>.<base64url key>" from a #pair= fragment. */
    parse(token) {
      const s = String(token || '').trim();
      const dot = s.lastIndexOf('.');
      if (dot <= 0) return null;
      const deviceId = s.slice(0, dot), key = s.slice(dot + 1);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return null;
      try { if (C.fromB64(key).length !== 32) return null; } catch (e) { return null; }
      return { deviceId, key };
    },
  };

  const OFFLINE = "Can't reach your Mac. Check that it's awake, Glide is open, and both are on the same Wi-Fi.";

  /** Run one action on the Mac. Resolves with the result; rejects with a GlideError {code, message}. */
  async function call(action, args, opts) {
    const o = opts || {};
    const p = o.pairing || Pairing.load();
    if (!p) throw new GlideError('unpaired', 'This iPhone is not paired with a Mac yet.', action);
    const key = C.fromB64(p.key);
    const id = C.uuid();
    const plain = C.utf8(JSON.stringify({ id, ts: Date.now(), action, args: args || {} }));
    const nonce = C.random(12);
    const sealed = C.seal(key, nonce, plain, C.utf8('glide-phone-v1|' + p.deviceId + '|req'));
    const body = JSON.stringify({ v: 1, d: p.deviceId, n: C.b64url(nonce), c: C.b64url(sealed) });

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeout || 75000) : null;
    let res;
    try {
      res = await root.fetch((o.base || '') + '/api', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new GlideError(e && e.name === 'AbortError' ? 'timeout' : 'offline',
        e && e.name === 'AbortError' ? 'The Mac took too long to answer. Try again.' : OFFLINE, action);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 401) throw new GlideError('unpaired', 'The Mac no longer knows this iPhone. Pair it again.', action);
    if (res.status === 413) throw new GlideError('too-large', 'That is too big to send in one go. Try something smaller.', action);
    if (!res.ok) throw new GlideError('http', 'The Mac answered with an error (' + res.status + '). Try again.', action);
    let msg;
    try {
      const env = await res.json();
      const out = C.open(key, C.fromB64(env.n), C.fromB64(env.c), C.utf8('glide-phone-v1|' + p.deviceId + '|res'));
      if (!out) throw new Error('tag');
      msg = JSON.parse(C.fromUtf8(out));
    } catch (e) {
      throw new GlideError('bad-response', "The Mac's answer couldn't be read. Pair this iPhone again if it keeps happening.", action);
    }
    if (!msg || msg.id !== id) throw new GlideError('bad-response', "The Mac's answer didn't match the request. Try again.", action);
    if (!msg.ok) {
      const e = msg.error || {};
      throw new GlideError(String(e.code || 'failed'), String(e.message || 'Something went wrong on the Mac.'), action);
    }
    return msg.result;
  }

  root.GlideAPI = { call, Pairing, GlideError, OFFLINE };
})(typeof self !== 'undefined' ? self : this);
