import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPrompt,
  detectAuthFailure,
  extractBase64Png,
  generateImage,
  isPng,
  parseMarker,
  parseSessionId,
  PixmithError,
  readPngDimensions,
  slugForFilename,
} from "../src/codex.js";

// A PNG-shaped buffer: magic + IHDR chunk header (length 13), padded so it
// clears extractBase64Png's 1 KiB floor. The IHDR length bytes matter: the
// "iVBORw0KGgo" base64 marker covers the first 9 bytes of a real PNG.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(2048, 0x41)]);
const FAKE_PNG_B64 = FAKE_PNG.toString("base64");

test("slugForFilename: lowercases, dashes, trims, caps at 40 chars", () => {
  assert.equal(slugForFilename("A Red Circle!!  on white"), "a-red-circle-on-white");
  assert.equal(slugForFilename("   "), "image");
  assert.equal(slugForFilename("日本語"), "image");
  const long = slugForFilename("x".repeat(100));
  assert.ok(long.length <= 40);
  assert.ok(!long.endsWith("-"));
});

test("parseMarker: only the last non-empty line counts", () => {
  assert.deepEqual(parseMarker("thinking...\nDONE\n"), { ok: true });
  assert.deepEqual(parseMarker("ERROR: refused by policy"), { ok: false, reason: "refused by policy" });
  // An ERROR: earlier in the text (e.g. echoed from the prompt) is not a failure.
  assert.deepEqual(parseMarker("ERROR: this is in the prompt\n\nDONE"), { ok: true });
  assert.equal(parseMarker("some other final message"), null);
  assert.equal(parseMarker(""), null);
  assert.equal(parseMarker(null), null);
});

test("parseSessionId: finds the uuid in the codex banner", () => {
  const banner = "OpenAI Codex v0.140.0\n--------\nworkdir: /x\nsession id: 019ED294-A1BF-7E92-929F-59D20770D2D9\n--------\n";
  assert.equal(parseSessionId(banner), "019ed294-a1bf-7e92-929f-59d20770d2d9");
  assert.equal(parseSessionId("no id here"), null);
  assert.equal(parseSessionId(""), null);
});

test("detectAuthFailure: matches real sign-in phrases only", () => {
  assert.equal(detectAuthFailure("Error: not signed in. Run `codex login`.", ""), true);
  assert.equal(detectAuthFailure("", "401 Unauthorized"), true);
  // A prompt echoed back containing "unauthorized" is not an auth failure.
  assert.equal(detectAuthFailure("user\na sign reading UNAUTHORIZED PERSONNEL", "DONE"), false);
  assert.equal(detectAuthFailure("", ""), false);
});

test("buildPrompt: embeds prompt and size and the DONE/ERROR contract", () => {
  const p = buildPrompt("a fox", "1536x1024");
  assert.match(p, /IMAGE PROMPT: a fox/);
  assert.match(p, /SIZE: 1536x1024/);
  assert.match(p, /\nDONE\n/);
  assert.match(p, /ERROR: <short reason>/);
  assert.match(buildPrompt("a fox", "auto"), /SIZE: auto \(model decides\)/);
});

test("extractBase64Png: decodes the largest valid PNG, tolerates line breaks", () => {
  const wrapped = FAKE_PNG_B64.replace(/(.{76})/g, "$1\n");
  const text = `{"type":"image","data":"${wrapped}"}`;
  const out = extractBase64Png(text);
  assert.ok(out);
  assert.ok(out.equals(FAKE_PNG));
  assert.equal(extractBase64Png("nothing here"), null);
  assert.equal(extractBase64Png(""), null);
  // Too small to be a real image is ignored.
  assert.equal(extractBase64Png(PNG_MAGIC.toString("base64")), null);
});

test("isPng: true for PNG magic, false otherwise or when missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-test-"));
  try {
    const good = path.join(dir, "good.png");
    const bad = path.join(dir, "bad.png");
    await fs.writeFile(good, FAKE_PNG);
    await fs.writeFile(bad, "this is a log file pretending to be a png");
    assert.equal(await isPng(good), true);
    assert.equal(await isPng(bad), false);
    assert.equal(await isPng(path.join(dir, "missing.png")), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readPngDimensions: reads width/height from IHDR, null otherwise", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-test-"));
  try {
    const ihdr = Buffer.alloc(8);
    ihdr.writeUInt32BE(1254, 0);
    ihdr.writeUInt32BE(768, 4);
    const png = Buffer.concat([PNG_MAGIC, Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, Buffer.alloc(64)]);
    const good = path.join(dir, "good.png");
    const bad = path.join(dir, "bad.png");
    const short = path.join(dir, "short.png");
    await fs.writeFile(good, png);
    await fs.writeFile(bad, "not a png at all, definitely more than 24 bytes long");
    await fs.writeFile(short, PNG_MAGIC);
    assert.deepEqual(await readPngDimensions(good), { width: 1254, height: 768 });
    assert.equal(await readPngDimensions(bad), null);
    assert.equal(await readPngDimensions(short), null);
    assert.equal(await readPngDimensions(path.join(dir, "missing.png")), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("generateImage: rejects bad input before touching codex", async () => {
  await assert.rejects(generateImage({ prompt: "" }), (e) => e instanceof PixmithError && e.kind === "bad_request");
  await assert.rejects(generateImage({ prompt: "x", size: "3840x3840" }), (e) => e.kind === "bad_request" && /too many pixels/.test(e.message));
  await assert.rejects(generateImage({ prompt: "x", outputDir: "relative/dir" }), (e) => e.kind === "bad_request" && /absolute/.test(e.message));
});
