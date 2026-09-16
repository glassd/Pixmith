import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSize, SIZE_LIMITS, config } from "../src/config.js";

test("config.version matches package.json", async () => {
  const { default: pkg } = await import("../package.json", { with: { type: "json" } });
  assert.equal(config.version, pkg.version);
});

test("normalizeSize: empty/undefined defaults to 1024x1024", () => {
  for (const s of [undefined, null, "", "   "]) {
    assert.deepEqual(normalizeSize(s), { value: "1024x1024", note: "", error: null });
  }
});

test("normalizeSize: auto and shortcuts", () => {
  assert.equal(normalizeSize("auto").value, "auto");
  assert.equal(normalizeSize("AUTO").value, "auto");
  assert.equal(normalizeSize("1k").value, "1024x1024");
  assert.equal(normalizeSize(" 2K ").value, "2048x2048");
  assert.equal(normalizeSize("4K").value, "3840x2160");
});

test("normalizeSize: accepts the popular gpt-image-2 sizes verbatim", () => {
  for (const s of ["1024x1024", "1536x1024", "1024x1536", "3840x2160", "2160x3840", "2048x2048"]) {
    const r = normalizeSize(s);
    assert.equal(r.value, s, s);
    assert.equal(r.note, "");
    assert.equal(r.error, null);
  }
});

test("normalizeSize: accepts × and * separators and surrounding whitespace", () => {
  assert.equal(normalizeSize("1536×1024").value, "1536x1024");
  assert.equal(normalizeSize("1536 * 1024").value, "1536x1024");
});

test("normalizeSize: rounds edges to a multiple of 16 with a note", () => {
  const r = normalizeSize("1000x1000");
  assert.equal(r.value, "1008x1008");
  assert.match(r.note, /rounded 1000x1000 to 1008x1008/);
  assert.equal(r.error, null);
});

test("normalizeSize: rejects sizes over the pixel cap", () => {
  const r = normalizeSize("3840x3840");
  assert.equal(r.value, null);
  assert.match(r.error, /too many pixels/);
});

test("normalizeSize: rejects sizes under the pixel floor", () => {
  for (const s of ["256x256", "512x512", "800x800"]) {
    const r = normalizeSize(s);
    assert.equal(r.value, null, s);
    assert.match(r.error, /too few pixels/, s);
  }
});

test("normalizeSize: rejects edges over 3840", () => {
  const r = normalizeSize("4096x2160");
  assert.equal(r.value, null);
  assert.match(r.error, /longest edge/);
});

test("normalizeSize: rejects aspect ratios over 3:1", () => {
  const r = normalizeSize("3840x1024");
  assert.equal(r.value, null);
  assert.match(r.error, /aspect ratio/);
});

test("normalizeSize: rejects unparseable input", () => {
  const r = normalizeSize("banana");
  assert.equal(r.value, null);
  assert.match(r.error, /could not parse/);
});

test("normalizeSize: every accepted value satisfies SIZE_LIMITS", () => {
  const samples = ["1024x1024", "1536x1024", "3840x2160", "1000x1000", "1280x720", "2000x2000", "2880x960"];
  for (const s of samples) {
    const r = normalizeSize(s);
    if (r.value === null) continue;
    const [w, h] = r.value.split("x").map(Number);
    assert.equal(w % SIZE_LIMITS.step, 0, `${s} width`);
    assert.equal(h % SIZE_LIMITS.step, 0, `${s} height`);
    assert.ok(Math.max(w, h) <= SIZE_LIMITS.maxEdge, `${s} edge`);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= SIZE_LIMITS.maxRatio, `${s} ratio`);
    assert.ok(w * h >= SIZE_LIMITS.minPixels && w * h <= SIZE_LIMITS.maxPixels, `${s} pixels`);
  }
});
