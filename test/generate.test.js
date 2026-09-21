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
process.env.PIXMITH_FAST_PROMPT = "true";
process.env.PIXMITH_CODEX_MODEL = "gpt-test-mini";
process.env.PIXMITH_CODEX_EFFORT = "low";

const { generateImage } = await import("../src/codex.js");
const { readUsage } = await import("../src/usage.js");
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

  assert.equal(res.stoppedEarly, false);

  const { args, stdin, promptFile, promptFileText } = await lastCall();
  assert.ok(args.includes("--json"));
  assert.ok(!args.includes("-i"));
  assert.equal(args.at(-1), "-");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-test-mini");
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.match(stdin, /IMAGE PROMPT: a fox/);

  // Fast path: the ready-made image_gen prompt travels in a file, which is removed afterwards.
  assert.match(stdin, /FAST PATH/);
  assert.match(promptFileText, /^Generate exactly ONE raster image\. The image must be 1024x1024 pixels\./);
  assert.match(promptFileText, /\n\na fox\n$/);
  await assert.rejects(fs.access(promptFile));
});

test("generateImage: stops Codex as soon as the finished PNG is on disk", { skip }, async () => {
  process.env.FAKE_MODE = "early";
  await reset();
  const stages = [];
  const t0 = Date.now();
  const res = await generateImage({ prompt: "a fox", onStage: (s) => stages.push(s) });
  assert.equal(res.stoppedEarly, true);
  assert.equal(res.size, "1024x768");
  assert.ok(Date.now() - t0 < 5000, "did not wait for the hung closing turn");
  assert.deepEqual(stages, ["starting", "session_started", "saving"]);
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
  assert.doesNotMatch(stdin, /FAST PATH/, "edits keep the agent's own prompt rewrite");
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

test("readUsage: newest session log wins, the job's own log is preferred, big logs are read from the tail", { skip }, async () => {
  const dir = path.join(codexHome, "sessions", "2026", "09", "21");
  await fs.mkdir(dir, { recursive: true });
  const entry = (used, ts) =>
    JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: used, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
          secondary: { used_percent: 1, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 },
          credits: { has_credits: false, unlimited: false, balance: "0" },
          plan_type: "plus",
        },
      },
    });
  const older = path.join(dir, "rollout-a-11111111-1111-1111-1111-111111111111.jsonl");
  const newer = path.join(dir, "rollout-b-22222222-2222-2222-2222-222222222222.jsonl");
  // The newer log is large, like a real one that carries a base64 image, with the snapshot at the end.
  await fs.writeFile(older, `${entry(10, "2026-09-21T10:00:00Z")}\n`);
  await fs.writeFile(newer, `${JSON.stringify({ payload: { blob: "A".repeat(400_000) } })}\n${entry(42, "2026-09-21T11:00:00Z")}\n`);
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(older, past, past);

  assert.equal((await readUsage()).windows[0].usedPercent, 42);
  // Asking for a specific session still returns the freshest snapshot overall.
  assert.equal((await readUsage({ sessionId: "11111111-1111-1111-1111-111111111111" })).windows[0].usedPercent, 42);

  await fs.rm(path.join(codexHome, "sessions"), { recursive: true, force: true });
  assert.equal(await readUsage(), null);
});

test("generateImage: an early-stopped edit still reports its session id and input images", { skip }, async () => {
  // The usage line is looked up by session id, and edits are stopped early like
  // generations, so the id must survive that path.
  process.env.FAKE_MODE = "ok";
  await reset();
  const seed = await generateImage({ prompt: "seed" });
  const src = path.join(root, "edit-src.png");
  await fs.copyFile(seed.path, src);
  await reset();

  process.env.FAKE_MODE = "early";
  const res = await generateImage({ prompt: "make it snowing", mode: "edit", images: [src] });
  assert.equal(res.mode, "edit");
  assert.equal(res.stoppedEarly, true);
  assert.equal(res.sessionId, "0a0b0c0d-1111-2222-3333-444455556666");
  assert.deepEqual(res.inputImages, [src]);
  assert.equal(res.requestedSize, "auto");
});
