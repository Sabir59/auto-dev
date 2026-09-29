#!/usr/bin/env node
// Usage: node worker/pixeldiff.mjs <expected.png> <actual.png> [diff.png]
//
// Deterministic visual check for any two renders (Figma export vs. browser
// screenshot, or anything else): counts pixels that differ beyond
// pixelmatch's anti-aliasing-aware threshold, and breaks the count down into
// 40px horizontal bands so a mismatch can be located, not just measured.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const [expectedPath, actualPath, diffPath] = process.argv.slice(2);
if (!expectedPath || !actualPath) {
  console.error("usage: pixeldiff.mjs <expected.png> <actual.png> [diff.png]");
  process.exit(2);
}

const a = PNG.sync.read(readFileSync(expectedPath));
const b = PNG.sync.read(readFileSync(actualPath));
if (a.width !== b.width || a.height !== b.height) {
  console.log(JSON.stringify({ ok: false, error: `size mismatch: expected ${a.width}x${a.height}, actual ${b.width}x${b.height}` }));
  process.exit(1);
}

const { width, height } = a;
const diff = new PNG({ width, height });
const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 });
if (diffPath) writeFileSync(diffPath, PNG.sync.write(diff));

// pixelmatch paints differing pixels pure red (255,0,0) in the diff image.
const BAND = 40;
const bands = [];
for (let y0 = 0; y0 < height; y0 += BAND) {
  let n = 0;
  for (let y = y0; y < Math.min(y0 + BAND, height); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) n++;
    }
  }
  if (n > 0) bands.push({ y: `${y0}-${Math.min(y0 + BAND, height)}`, diffPixels: n });
}

console.log(
  JSON.stringify(
    { width, height, diffPixels, diffPercent: +((100 * diffPixels) / (width * height)).toFixed(2), bands, diffImage: diffPath || null },
    null,
    1
  )
);
