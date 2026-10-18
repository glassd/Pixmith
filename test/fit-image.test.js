import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";

import {
  describe as describeImage,
  fit,
  keyOut,
  LIMITS,
  packIco,
  parseColor,
  parseSize,
  readImage,
  run,
  suggestGenerationSize,
} from "../skills/project-images/scripts/fit-image.mjs";

/** Solid RGBA image, optionally with a centred square of another colour. */
function solid(w, h, rgba, inner = null) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inside = inner && x >= inner.x && x < inner.x + inner.size && y >= inner.y && y < inner.y + inner.size;
      const c = inside ? inner.rgba : rgba;
      data.set(c, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pixmith-fit-"));
}

async function writePng(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  await fs.writeFile(file, PNG.sync.write(png));
}

test("suggestGenerationSize: always returns a size gpt-image-2 accepts", () => {
  for (const [w, h] of [
    [1200, 630],
    [180, 180],
    [16, 16],
    [1280, 320],
    [320, 1280],
    [1920, 1080],
    [4096, 4096],
    [5000, 400],
  ]) {
    const r = suggestGenerationSize(w, h);
    const [gw, gh] = r.generate.split("x").map(Number);
    assert.equal(gw % LIMITS.step, 0, r.generate);
    assert.equal(gh % LIMITS.step, 0, r.generate);
    assert.ok(Math.max(gw, gh) <= LIMITS.maxEdge, r.generate);
    assert.ok(Math.max(gw, gh) / Math.min(gw, gh) <= LIMITS.maxRatio, r.generate);
    assert.ok(gw * gh >= LIMITS.minPixels && gw * gh <= LIMITS.maxPixels, r.generate);
  }
});

test("suggestGenerationSize: covers the target, matches its ratio, prefers familiar sizes", () => {
  const og = suggestGenerationSize(1200, 630);
  const [w, h] = og.generate.split("x").map(Number);
  assert.ok(w >= 1200 && h >= 630);
  assert.ok(Math.abs(w / h - 1200 / 630) < 0.03, og.generate);
  assert.equal(suggestGenerationSize(180, 180).generate, "1024x1024");
  assert.equal(suggestGenerationSize(1920, 1080).generate, "2048x1152");
  assert.match(suggestGenerationSize(1280, 320).notes.join(" "), /3:1/);
  assert.match(suggestGenerationSize(4096, 4096).notes.join(" "), /upscaled/);
});

test("parseSize / parseColor", () => {
  assert.deepEqual(parseSize("1200x630"), { w: 1200, h: 630 });
  assert.deepEqual(parseSize(" 32 × 32 "), { w: 32, h: 32 });
  assert.throws(() => parseSize("big"), /invalid size/);
  assert.throws(() => parseSize("0x10"), /invalid size/);
  assert.deepEqual(parseColor("#00ff80"), [0, 255, 128]);
  assert.deepEqual(parseColor("FFFFFF"), [255, 255, 255]);
  assert.throws(() => parseColor("green"), /invalid colour/);
});

test("fit cover: exact output size, crops the long side around the centre", () => {
  // 300x100 white with a red 100x100 block in the middle; cover to 100x100
  // must keep only the red block.
  const src = solid(300, 100, [255, 255, 255, 255], { x: 100, y: 0, size: 100, rgba: [255, 0, 0, 255] });
  const out = fit(src, 100, 100, { mode: "cover" });
  assert.equal(out.width, 100);
  assert.equal(out.height, 100);
  assert.deepEqual(pixel(out, 0, 50), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out, 99, 50), [255, 0, 0, 255]);
  const left = fit(src, 100, 100, { mode: "cover", gravity: "left" });
  assert.deepEqual(pixel(left, 50, 50), [255, 255, 255, 255]);
});

test("fit contain: pads with the background, or transparency by default", () => {
  const src = solid(200, 100, [0, 0, 255, 255]);
  const padded = fit(src, 100, 100, { mode: "contain", background: [255, 255, 255] });
  assert.deepEqual(pixel(padded, 50, 5), [255, 255, 255, 255]);
  assert.deepEqual(pixel(padded, 50, 50), [0, 0, 255, 255]);
  const clear = fit(src, 100, 100, { mode: "contain" });
  assert.equal(pixel(clear, 50, 5)[3], 0);
  assert.equal(describeImage(clear).has_alpha, true);
});

test("fit: downscaling averages, and transparent pixels don't darken edges", () => {
  // Half opaque red, half fully transparent black: premultiplied resampling
  // must keep the colour red, not drift toward black.
  const src = solid(2, 1, [255, 0, 0, 255]);
  src.data.set([0, 0, 0, 0], 4);
  const out = fit(src, 1, 1, { mode: "contain" });
  const [r, g, b, a] = pixel(out, 0, 0);
  assert.equal(r, 255);
  assert.equal(g, 0);
  assert.equal(b, 0);
  assert.ok(a > 120 && a < 135, String(a));
});

test("fit: upscaling works too", () => {
  const out = fit(solid(10, 10, [10, 20, 30, 255]), 64, 64);
  assert.equal(out.width, 64);
  assert.deepEqual(pixel(out, 32, 32), [10, 20, 30, 255]);
});

test("keyOut: clears a flat background, keeps the subject, reports the key colour", () => {
  const src = solid(40, 40, [0, 255, 0, 255], { x: 10, y: 10, size: 20, rgba: [200, 30, 30, 255] });
  const { image, key, clearPercent } = keyOut(src);
  assert.deepEqual(key, [0, 255, 0]);
  assert.equal(pixel(image, 0, 0)[3], 0);
  assert.deepEqual(pixel(image, 20, 20), [200, 30, 30, 255]);
  assert.equal(clearPercent, 75);
});

test("packIco: valid header and directory", () => {
  const ico = packIco([
    { size: 16, data: Buffer.from("aaaa") },
    { size: 256, data: Buffer.from("bbbbbb") },
  ]);
  assert.equal(ico.readUInt16LE(2), 1, "type 1 = icon");
  assert.equal(ico.readUInt16LE(4), 2, "two images");
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0, "256 is stored as 0");
  assert.equal(ico.readUInt32LE(6 + 8), 4);
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32);
  assert.equal(ico.readUInt32LE(6 + 16 + 12), 6 + 32 + 4);
});

test("CLI: fit to JPEG and PNG, ico, key-out and info round-trip through files", async () => {
  const dir = await tmpdir();
  try {
    const src = path.join(dir, "src.png");
    await writePng(src, solid(300, 200, [0, 255, 0, 255], { x: 100, y: 50, size: 100, rgba: [20, 40, 200, 255] }));

    const og = await run(["fit", src, path.join(dir, "out", "og.jpg"), "--size", "120x63"]);
    assert.equal(og.size, "120x63");
    assert.equal((await readImage(og.file)).format, "jpeg");

    const png = await run(["fit", src, path.join(dir, "touch.png"), "--size", "18x18"]);
    assert.equal(png.size, "18x18");
    assert.equal(png.has_alpha, false);

    const ico = await run(["ico", src, path.join(dir, "favicon.ico"), "--sizes", "16,32"]);
    assert.deepEqual(ico.sizes, [16, 32]);
    assert.equal(ico.cropped_to_square, true);
    const icoBuf = await fs.readFile(ico.file);
    assert.equal(icoBuf.readUInt16LE(4), 2);

    const cut = await run(["key-out", src, path.join(dir, "cut.png")]);
    assert.equal(cut.key_color, "#00ff00");
    assert.equal(cut.has_alpha, true);

    const info = await run(["info", cut.file]);
    assert.equal(info.size, "300x200");
    assert.equal(info.has_alpha, true);
    assert.ok(info.transparent_percent > 80);

    await assert.rejects(run(["key-out", src, path.join(dir, "cut.jpg")]), /must be a \.png/);
    await assert.rejects(run(["fit", src, path.join(dir, "x.webp"), "--size", "10x10"]), /\.png, \.jpg or \.jpeg/);
    await assert.rejects(run(["nope"]), /commands:/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
