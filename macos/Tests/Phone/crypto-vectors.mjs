// Checks Web/crypto.js (Glide Remote's ChaCha20-Poly1305) against the RFC 8439 test vectors
// (rfc8439-vectors.json, transcribed from the RFC text) and against Node's OpenSSL chacha20-poly1305.
//
//   node Tests/Phone/crypto-vectors.mjs                      run every check, exit 1 on failure
//   node Tests/Phone/crypto-vectors.mjs seal <key> <nonce> <aad> <plaintext>   (hex in, hex out)
//   node Tests/Phone/crypto-vectors.mjs open <key> <nonce> <aad> <sealed>      (hex in, hex or "null" out)
//
// PhoneWebCryptoTests (Swift) runs this script and also cross-checks it against CryptoKit both ways.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodeCrypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// Load the browser file as a plain script with a CommonJS-style `module` (the repo's package.json says "type": "module").
const mod = { exports: {} };
new Function('module', readFileSync(join(here, '../../Sources/Features/Phone/Web/crypto.js'), 'utf8'))(mod);
const C = mod.exports;
const { hex, fromHex } = C;

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'seal') {
  const [k, n, a, p] = rest.map((x) => fromHex(x || ''));
  process.stdout.write(hex(C.seal(k, n, p, a)) + '\n');
  process.exit(0);
}
if (mode === 'open') {
  const [k, n, a, s] = rest.map((x) => fromHex(x || ''));
  const out = C.open(k, n, s, a);
  process.stdout.write((out ? hex(out) : 'null') + '\n');
  process.exit(0);
}

let failed = 0, passed = 0;
function check(name, got, want) {
  if (got === want) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
}

const v = JSON.parse(readFileSync(join(here, 'rfc8439-vectors.json'), 'utf8'));
check('2.3.2 block', hex(C.chacha20Block(fromHex(v.block.key), v.block.counter, fromHex(v.block.nonce))), v.block.out);
v.chacha20.forEach((t, i) => {
  check(`chacha20 #${i} encrypt`, hex(C.chacha20(fromHex(t.key), t.counter, fromHex(t.nonce), fromHex(t.pt))), t.ct);
  check(`chacha20 #${i} decrypt`, hex(C.chacha20(fromHex(t.key), t.counter, fromHex(t.nonce), fromHex(t.ct))), t.pt);
});
v.poly1305.forEach((t, i) => check(`poly1305 #${i}`, hex(C.poly1305(fromHex(t.key), fromHex(t.msg))), t.tag));
v.keygen.forEach((t, i) => check(`keygen #${i}`, hex(C.chacha20Block(fromHex(t.key), 0, fromHex(t.nonce)).slice(0, 32)), t.otk));
v.aead.forEach((t, i) => {
  const sealed = C.seal(fromHex(t.key), fromHex(t.nonce), fromHex(t.pt), fromHex(t.aad));
  check(`aead #${i} seal`, hex(sealed), t.ct + t.tag);
  const opened = C.open(fromHex(t.key), fromHex(t.nonce), fromHex(t.ct + t.tag), fromHex(t.aad));
  check(`aead #${i} open`, opened ? hex(opened) : 'null', t.pt);
  const bad = fromHex(t.ct + t.tag); bad[bad.length - 1] ^= 1;
  check(`aead #${i} rejects a bad tag`, String(C.open(fromHex(t.key), fromHex(t.nonce), bad, fromHex(t.aad))), 'null');
  const badAad = fromHex(t.aad); badAad[0] ^= 1;
  check(`aead #${i} rejects other AAD`, String(C.open(fromHex(t.key), fromHex(t.nonce), fromHex(t.ct + t.tag), badAad)), 'null');
});

// Independent oracle: Node's OpenSSL, many lengths (block boundaries, multi-block, a 1 MB body).
const lengths = [...Array(300).keys(), 1023, 1024, 1025, 65536 + 7, 1 << 20];
for (const len of lengths) {
  const key = C.random(32), nonce = C.random(12), aad = C.random(len % 40), pt = C.random(len);
  const c = nodeCrypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: pt.length });
  const want = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]).toString('hex');
  const got = hex(C.seal(key, nonce, pt, aad));
  check(`openssl seal len=${len}`, got, want);
  const back = C.open(key, nonce, fromHex(want), aad);
  check(`openssl open len=${len}`, back ? hex(back) : 'null', hex(pt));
}

// base64url / base64 round trips and the alphabet.
for (let n = 0; n < 70; n++) {
  const b = C.random(n);
  check(`b64url len=${n}`, hex(C.fromB64(C.b64url(b))), hex(b));
  check(`b64 len=${n}`, C.b64(b), Buffer.from(b).toString('base64'));
  check(`b64url node len=${n}`, C.b64url(b), Buffer.from(b).toString('base64url'));
}
check('uuid shape', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(C.uuid()), true);

console.log(`${failed === 0 ? 'ok' : 'FAILED'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
