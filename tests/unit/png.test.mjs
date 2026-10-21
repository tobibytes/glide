import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodePng, diffImages, downscale, encodePng, maskRects } from "../harness/png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function gradient(w, h, alpha = 255) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 7, y * 5, (x * y) & 255, alpha], (y * w + x) * 4);
  return { width: w, height: h, data };
}

test("encode/decode round-trips RGB and RGBA", () => {
  for (const alpha of [255, 200]) {
    const img = gradient(37, 23, alpha);
    const back = decodePng(encodePng(img));
    assert.equal(back.width, 37);
    assert.equal(back.height, 23);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  }
});

test("decodes committed baselines", () => {
  const dir = path.join(here, "../visual/baselines");
  const theme = readdirSync(dir).find((d) => !d.startsWith("."));
  if (!theme) return;
  const file = readdirSync(path.join(dir, theme)).find((f) => f.endsWith(".png"));
  const img = decodePng(readFileSync(path.join(dir, theme, file)));
  assert.ok(img.width > 100 && img.height > 100);
});

test("diff counts changed pixels and respects the threshold", () => {
  const a = gradient(10, 10);
  const b = { ...a, data: Uint8Array.from(a.data) };
  b.data[0] += 10; // below threshold
  b.data.set([255, 255, 255, 255], 4 * 55);
  const d = diffImages(a, b, { threshold: 24 });
  assert.equal(d.diffPixels, 1);
  assert.equal(d.sizeMismatch, false);
  const sized = diffImages(a, gradient(12, 10));
  assert.equal(sized.sizeMismatch, true);
  assert.ok(sized.diffPixels >= 20);
});

test("downscale averages and maskRects paints", () => {
  const img = { width: 2, height: 2, data: Uint8Array.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]) };
  const half = downscale(img, 2);
  assert.deepEqual([...half.data], [100, 100, 100, 255]);
  maskRects(img, [{ x: 1, y: 1, width: 1, height: 1 }]);
  assert.deepEqual([...img.data.slice(12)], [255, 0, 255, 255]);
});
