import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPrompt,
  detectAuthFailure,
  detectImageType,
  detectUsageLimit,
  extractBase64Png,
  generateImage,
  isPng,
  parseCodexEvent,
  parseMarker,
  parseSessionId,
  PixmithError,
  readPngDimensions,
  rejectedJsonFlag,
  slugForFilename,
  validateInputImages,
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

test("buildPrompt: edit mode labels the attached images and keeps the contract", () => {
  const p = buildPrompt("make the sky purple", "auto", { mode: "edit", imageCount: 2 });
  assert.match(p, /EDIT the attached image/);
  assert.match(p, /- Image 1: edit target/);
  assert.match(p, /- Image 2: reference/);
  assert.match(p, /EDIT INSTRUCTION: make the sky purple/);
  assert.match(p, /SIZE: auto \(keep the edit target's aspect ratio\)/);
  assert.match(p, /Do NOT call view_image/);
  assert.match(p, /\nDONE\n/);
  // References without edit mode are all references; no images means no image section.
  assert.match(buildPrompt("a fox", "auto", { imageCount: 1 }), /- Image 1: reference/);
  assert.doesNotMatch(buildPrompt("a fox", "auto"), /INPUT IMAGES/);
});

test("parseCodexEvent: maps JSONL events to session id, stage, text and errors", () => {
  const ev = (o) => parseCodexEvent(JSON.stringify(o));
  assert.deepEqual(ev({ type: "thread.started", thread_id: "01A0C5B0-706C-7E30-9694-5001E0DED97A" }), {
    type: "thread.started",
    sessionId: "01a0c5b0-706c-7e30-9694-5001e0ded97a",
    stage: "session_started",
  });
  assert.equal(ev({ type: "turn.started" }).stage, "session_started");
  const talking = ev({ type: "item.completed", item: { type: "agent_message", text: "Generating one image." } });
  assert.equal(talking.stage, "rendering");
  assert.equal(talking.agentText, "Generating one image.");
  assert.equal(ev({ type: "item.completed", item: { type: "agent_message", text: "DONE" } }).stage, "finishing");
  assert.equal(ev({ type: "item.started", item: { type: "tool_call" } }).stage, "rendering");
  assert.equal(ev({ type: "turn.completed", usage: {} }).stage, "finishing");
  assert.equal(ev({ type: "turn.failed", error: { message: "usage limit reached" } }).error, "usage limit reached");
  assert.equal(ev({ type: "error", message: "stream disconnected" }).error, "stream disconnected");
  assert.deepEqual(ev({ type: "something.new" }), { type: "something.new" });
  // Anything that is not a JSON event is ignored rather than fatal.
  for (const junk of ["", "plain text", "{not json", "[1,2]", "{}", null]) assert.equal(parseCodexEvent(junk), null);
});

test("detectUsageLimit: matches plan-limit phrases only", () => {
  assert.equal(detectUsageLimit("You've hit your usage limit. Try again in 3 hours."), true);
  assert.equal(detectUsageLimit("", "429 Too Many Requests"), true);
  assert.equal(detectUsageLimit("image saved", ""), false);
  assert.equal(detectUsageLimit(), false);
});

test("detectImageType + validateInputImages: sniff real types and reject bad inputs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-inputs-"));
  try {
    const files = {
      "a.png": FAKE_PNG,
      "b.jpg": Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]),
      "c.webp": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]),
      "d.gif": Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]),
      "e.png": Buffer.from("this is a log file, not an image at all"),
    };
    for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(dir, name), data);
    const at = (n) => path.join(dir, n);

    assert.equal(await detectImageType(at("a.png")), "png");
    assert.equal(await detectImageType(at("b.jpg")), "jpeg");
    assert.equal(await detectImageType(at("c.webp")), "webp");
    assert.equal(await detectImageType(at("d.gif")), "gif");
    assert.equal(await detectImageType(at("e.png")), null);
    assert.equal(await detectImageType(at("missing.png")), null);

    assert.deepEqual(await validateInputImages(undefined), []);
    assert.deepEqual(await validateInputImages([at("a.png"), ` ${at("b.jpg")} `]), [at("a.png"), at("b.jpg")]);
    const bad = (input, re) => assert.rejects(validateInputImages(input), (e) => e.kind === "bad_request" && re.test(e.message));
    await bad("a.png", /array/);
    await bad(["a.png"], /absolute/);
    await bad([at("missing.png")], /not found/);
    await bad([dir], /not a file/);
    await bad([at("e.png")], /not a PNG, JPEG, WebP or GIF/);
    await bad([""], /non-empty/);
    await bad(Array(5).fill(at("a.png")), /At most 4/);

    // generateImage rejects these before any Codex session starts.
    await assert.rejects(generateImage({ prompt: "x", mode: "edit" }), (e) => e.kind === "bad_request" && /needs the image/.test(e.message));
    await assert.rejects(generateImage({ prompt: "x", mode: "remix" }), (e) => e.kind === "bad_request");
    const aborted = AbortSignal.abort();
    await assert.rejects(generateImage({ prompt: "x", signal: aborted }), (e) => e.kind === "cancelled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejectedJsonFlag: only an argument error about --json triggers the plain-text fallback", () => {
  const stderr = "error: unexpected argument '--json' found\n\nUsage: codex exec [OPTIONS] [PROMPT]";
  assert.equal(rejectedJsonFlag({ code: 2, stderr }), true);
  assert.equal(rejectedJsonFlag({ code: 0, stderr }), false);
  assert.equal(rejectedJsonFlag({ code: 2, stderr, sessionId: "abc" }), false);
  assert.equal(rejectedJsonFlag({ code: 2, stderr, aborted: true }), false);
  assert.equal(rejectedJsonFlag({ code: 1, stderr: "stream error while using --json output" }), false);
  assert.equal(rejectedJsonFlag({ code: 1, stderr: "" }), false);
});
