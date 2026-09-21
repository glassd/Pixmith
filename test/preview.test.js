import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import jpeg from "jpeg-js";

import { downscale, makeInlineImage } from "../src/preview.js";
import { noisyPng } from "../fixtures/noisy-png.js";

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-preview-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("makeInlineImage: a PNG within the budget is returned untouched", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "small.png");
    const data = noisyPng(32, 32);
    await fs.writeFile(file, data);
    const out = await makeInlineImage(file, 1024 * 1024);
    assert.equal(out.preview, false);
    assert.equal(out.mimeType, "image/png");
    assert.deepEqual(out.data, data);
  }));

test("makeInlineImage: a PNG over the budget becomes a JPEG preview that fits", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "big.png");
    const data = noisyPng(900, 600);
    await fs.writeFile(file, data);
    const budget = 200 * 1024;
    assert.ok(data.length > budget, "the fixture must start over budget");

    const out = await makeInlineImage(file, budget);
    assert.equal(out.preview, true);
    assert.equal(out.mimeType, "image/jpeg");
    assert.ok(out.data.length <= budget);
    assert.deepEqual([...out.data.subarray(0, 3)], [0xff, 0xd8, 0xff], "real JPEG bytes");
    // Noise compresses badly, so fitting means shrinking — with the aspect ratio kept.
    assert.ok(out.width < 900);
    assert.ok(Math.abs(out.width / out.height - 1.5) < 0.02);
    const decoded = jpeg.decode(out.data);
    assert.deepEqual([decoded.width, decoded.height], [out.width, out.height]);
  }));

test("makeInlineImage: transparency is flattened onto white, and an impossible budget yields null", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "clear.png");
    await fs.writeFile(file, noisyPng(400, 400, { alpha: 0 }));
    const out = await makeInlineImage(file, 100 * 1024);
    assert.equal(out.preview, true);
    const { data } = jpeg.decode(out.data);
    assert.ok(data[0] > 250 && data[1] > 250 && data[2] > 250, "fully transparent pixels come out white, not black");

    assert.equal(await makeInlineImage(file, 200), null);
    await assert.rejects(makeInlineImage(path.join(dir, "missing.png"), 1000));
  }));

test("downscale: averages source pixels", () => {
  // 2x2 -> 1x1: black, white, white, black averages to mid grey.
  const px = (v) => [v, v, v, 255];
  const src = Buffer.from([...px(0), ...px(255), ...px(255), ...px(0)]);
  assert.deepEqual([...downscale(src, 2, 2, 1, 1)], [128, 128, 128, 255]);
  // 4x1 -> 2x1 keeps left/right halves apart.
  const row = Buffer.from([...px(10), ...px(30), ...px(200), ...px(220)]);
  assert.deepEqual([...downscale(row, 4, 1, 2, 1)], [20, 20, 20, 255, 210, 210, 210, 255]);
});
