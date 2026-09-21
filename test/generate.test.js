import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end through generateImage against a fake Codex binary. config.js reads
// the environment at import time, so it is set up before the dynamic import.
const skip = process.platform === "win32" ? "the fake codex is a shebang script" : false;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-gen-"));
const codexHome = path.join(root, "codex-home");
const outDir = path.join(root, "out");
await fs.mkdir(codexHome, { recursive: true });
process.env.CODEX_BIN = fileURLToPath(new URL("../fixtures/fake-codex.cjs", import.meta.url));
process.env.CODEX_HOME = codexHome;
process.env.PIXMITH_OUTPUT_DIR = outDir;
process.env.PIXMITH_BYPASS_SANDBOX = "false";

const { generateImage } = await import("../src/codex.js");
const lastCall = async () => JSON.parse(await fs.readFile(path.join(codexHome, "last-call.json"), "utf8"));
const reset = () => fs.rm(path.join(codexHome, "generated_images"), { recursive: true, force: true });

test.after(() => fs.rm(root, { recursive: true, force: true }));

test("generateImage: finds the session's PNG via JSON events and reports stages", { skip }, async () => {
  process.env.FAKE_MODE = "ok";
  const stages = [];
  const res = await generateImage({ prompt: "a fox", onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ["starting", "session_started", "rendering", "finishing", "saving"]);
  assert.equal(res.sessionId, "0a0b0c0d-1111-2222-3333-444455556666");
  assert.equal(res.size, "1024x768");
  assert.equal(res.requestedSize, "1024x1024");
  assert.equal(res.mode, "generate");
  assert.equal(path.dirname(res.path), outDir);
  assert.ok(res.durationMs >= 0);

  const { args, stdin } = await lastCall();
  assert.ok(args.includes("--json"));
  assert.ok(!args.includes("-i"));
  assert.equal(args.at(-1), "-");
  assert.match(stdin, /IMAGE PROMPT: a fox/);
});

test("generateImage: edit mode attaches each image with its own -i flag", { skip }, async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  const src = path.join(root, "src.png");
  const ref = path.join(root, "ref.png");
  const first = await generateImage({ prompt: "seed" });
  await fs.copyFile(first.path, src);
  await fs.copyFile(first.path, ref);
  await reset();

  const res = await generateImage({ prompt: "make it night", mode: "edit", images: [src, ref] });
  assert.equal(res.mode, "edit");
  assert.equal(res.requestedSize, "auto");
  assert.deepEqual(res.inputImages, [src, ref]);

  const { args, stdin } = await lastCall();
  const flags = args.map((a, i) => (a === "-i" ? args[i + 1] : null)).filter(Boolean);
  assert.deepEqual(flags, [src, ref]);
  assert.notEqual(args[args.lastIndexOf("-i") + 2], "-", "the prompt sentinel never directly follows the image list");
  assert.match(stdin, /EDIT INSTRUCTION: make it night/);
  assert.match(stdin, /- Image 1: edit target/);
});

test("generateImage: falls back to plain output when Codex rejects --json", { skip }, async () => {
  process.env.FAKE_MODE = "nojson";
  await reset();
  const res = await generateImage({ prompt: "a fox" });
  assert.equal(res.sessionId, "0a0b0c0d-1111-2222-3333-444455556666");
  assert.ok(!(await lastCall()).args.includes("--json"));
});

test("generateImage: aborting kills Codex and reports cancelled", { skip }, async () => {
  process.env.FAKE_MODE = "hang";
  await reset();
  const ac = new AbortController();
  const stages = [];
  const pending = generateImage({ prompt: "a fox", signal: ac.signal, onStage: (s) => { stages.push(s); if (s === "session_started") ac.abort(); } });
  await assert.rejects(pending, (e) => e.kind === "cancelled");
  assert.deepEqual(stages, ["starting", "session_started"]);
});

test("generateImage: classifies usage limits and refusals", { skip }, async () => {
  await reset();
  process.env.FAKE_MODE = "limit";
  await assert.rejects(generateImage({ prompt: "a fox" }), (e) => e.kind === "usage_limit" && /usage limit/.test(e.detail));
  process.env.FAKE_MODE = "refuse";
  await assert.rejects(generateImage({ prompt: "a fox" }), (e) => e.kind === "generation_failed" && /content policy/.test(e.message));
});
