import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end through generateImage against a fake Codex binary. config.js reads
// the environment at import time, so it is set up before the dynamic import.
// On Windows the fake runs through a .cmd shim, the way an npm-installed codex.cmd does.
const isWindows = process.platform === "win32";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-gen-"));
const codexHome = path.join(root, "codex-home");
const outDir = path.join(root, "out");
await fs.mkdir(codexHome, { recursive: true });
process.env.CODEX_BIN = fileURLToPath(new URL(`../fixtures/fake-codex.${isWindows ? "cmd" : "cjs"}`, import.meta.url));
process.env.CODEX_HOME = codexHome;
process.env.PIXMITH_OUTPUT_DIR = outDir;
process.env.PIXMITH_STATE_DIR = path.join(root, "state");
process.env.PIXMITH_BYPASS_SANDBOX = "false";
process.env.PIXMITH_FAST_PROMPT = "true";
process.env.PIXMITH_CODEX_MODEL = "gpt-test-mini";
process.env.PIXMITH_CODEX_EFFORT = "low";

const { generateImage, listRolloutLogs, runCodexCommand, writeMetadata } = await import("../src/codex.js");
const { checkStatus } = await import("../src/status.js");
const { config } = await import("../src/config.js");
const { readUsage } = await import("../src/usage.js");
const lastCall = async () => JSON.parse(await fs.readFile(path.join(codexHome, "last-call.json"), "utf8"));
const reset = () => fs.rm(path.join(codexHome, "generated_images"), { recursive: true, force: true });

test.after(() => fs.rm(root, { recursive: true, force: true }));

test("generateImage: finds the session's PNG via JSON events and reports stages", async () => {
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

test("generateImage: stops Codex as soon as the finished PNG is on disk", async () => {
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

test("generateImage: edit mode attaches each image with its own -i flag", async () => {
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

test("generateImage: falls back to plain output when Codex rejects --json", async () => {
  process.env.FAKE_MODE = "nojson";
  await reset();
  const res = await generateImage({ prompt: "a fox" });
  assert.equal(res.sessionId, "0a0b0c0d-1111-2222-3333-444455556666");
  assert.ok(!(await lastCall()).args.includes("--json"));
});

test("generateImage: aborting kills Codex and reports cancelled", async () => {
  process.env.FAKE_MODE = "hang";
  await reset();
  const ac = new AbortController();
  const stages = [];
  const pending = generateImage({ prompt: "a fox", signal: ac.signal, onStage: (s) => { stages.push(s); if (s === "session_started") ac.abort(); } });
  await assert.rejects(pending, (e) => e.kind === "cancelled");
  assert.deepEqual(stages, ["starting", "session_started"]);
});

test("generateImage: a cancel that lands before Codex starts stops the job without running Codex", { timeout: 15_000 }, async () => {
  process.env.FAKE_MODE = "hang";
  await reset();
  await fs.rm(path.join(codexHome, "last-call.json"), { force: true });
  const ac = new AbortController();
  // "starting" is reported after the pre-run snapshot, just before Codex is spawned.
  const onStage = (s) => s === "starting" && ac.abort();
  await assert.rejects(generateImage({ prompt: "a fox", signal: ac.signal, onStage }), (e) => e.kind === "cancelled");
  await assert.rejects(fs.access(path.join(codexHome, "last-call.json")), "Codex was never launched");
});

test("generateImage: output paths with spaces and brackets reach Codex intact", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  const dir = path.join(root, "my images (v2)");
  const res = await generateImage({ prompt: "a fox", outputDir: dir });
  assert.equal(path.dirname(res.path), dir);
  const { args } = await lastCall();
  assert.equal(args[args.indexOf("-C") + 1], dir);
});

test("generateImage: refuses paths cmd.exe would interpret instead of running them", { skip: !isWindows && "only .cmd shims go through cmd.exe" }, async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  await fs.rm(path.join(codexHome, "last-call.json"), { force: true });
  for (const name of ["out&echo pwned", "100%PATH%", "a^b"]) {
    await assert.rejects(
      generateImage({ prompt: "a fox", outputDir: path.join(root, name) }),
      (e) => e.kind === "bad_request" && /cmd\.exe/.test(e.message),
      name,
    );
  }
  await assert.rejects(fs.access(path.join(codexHome, "last-call.json")), "Codex was never launched");
});

test("generateImage: classifies usage limits and refusals", async () => {
  await reset();
  process.env.FAKE_MODE = "limit";
  await assert.rejects(generateImage({ prompt: "a fox" }), (e) => e.kind === "usage_limit" && /usage limit/.test(e.detail));
  process.env.FAKE_MODE = "refuse";
  await assert.rejects(generateImage({ prompt: "a fox" }), (e) => e.kind === "generation_failed" && /content policy/.test(e.message));
});

test("generateImage: text split mid-character across output chunks is decoded intact", async () => {
  await reset();
  process.env.FAKE_MODE = "refuse-split";
  await assert.rejects(generateImage({ prompt: "a fox" }), (e) => e.kind === "generation_failed" && e.message.endsWith("refusé — 内容"));
});

test("readUsage: newest session log wins, the job's own log is preferred, big logs are read from the tail", async () => {
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

test("generateImage: an early-stopped edit still reports its session id and input images", async () => {
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

test("generateImage: without a session id, only a folder that appeared during the run is used", async () => {
  process.env.FAKE_MODE = "anon";
  await reset();
  // An older session's image, made to look newest, must not be mistaken for this run's.
  const old = path.join(codexHome, "generated_images", "older-session", "old.png");
  await fs.mkdir(path.dirname(old), { recursive: true });
  await fs.writeFile(old, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(64)]));
  const future = new Date(Date.now() + 3_600_000);
  await fs.utimes(old, future, future);

  const res = await generateImage({ prompt: "a fox" });
  assert.equal(res.sessionId, null);
  assert.equal(res.codexHomeCopy, path.join(codexHome, "generated_images", "0a0b0c0d-1111-2222-3333-444455556666", "exec-1.png"));
});

test("listRolloutLogs: reads only the newest day folders unless asked for all", async () => {
  const sessions = path.join(codexHome, "sessions");
  const days = ["2025/12/31", "2026/09/01", "2026/09/02", "2026/09/10", "2026/10/01"];
  for (const day of days) {
    const dir = path.join(sessions, ...day.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `rollout-${day.replaceAll("/", "-")}.jsonl`), "{}\n");
  }
  try {
    const names = (m) => [...m.keys()].map((p) => path.basename(p)).sort();
    assert.deepEqual(names(await listRolloutLogs()), ["rollout-2026-09-02.jsonl", "rollout-2026-09-10.jsonl", "rollout-2026-10-01.jsonl"]);
    assert.equal((await listRolloutLogs({ days: Infinity })).size, days.length);
  } finally {
    await fs.rm(sessions, { recursive: true, force: true });
  }

  // A layout without date folders is listed in full.
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "rollout-flat.jsonl"), "{}\n");
  try {
    assert.deepEqual([...(await listRolloutLogs()).keys()], [path.join(sessions, "rollout-flat.jsonl")]);
  } finally {
    await fs.rm(sessions, { recursive: true, force: true });
  }
});

test("generateImage: writes a metadata sidecar beside the PNG", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  const res = await generateImage({ prompt: "  a fox in snow  ", size: "1000x1000" });
  assert.equal(res.metadataPath, res.path.replace(/\.png$/, ".json"));
  const meta = JSON.parse(await fs.readFile(res.metadataPath, "utf8"));
  const png = await fs.readFile(res.path);
  assert.deepEqual(
    { ...meta, created_at: undefined, duration_ms: undefined },
    {
      pixmith_version: config.version,
      created_at: undefined,
      mode: "generate",
      prompt: "a fox in snow",
      image: path.basename(res.path),
      sha256: createHash("sha256").update(png).digest("hex"),
      size: "1024x768",
      width: 1024,
      height: 768,
      requested_size: "1008x1008",
      size_note: "rounded 1000x1000 to 1008x1008 (each edge must be a multiple of 16)",
      background: "auto",
      has_alpha: false,
      reference_images: [],
      codex_session_id: "0a0b0c0d-1111-2222-3333-444455556666",
      duration_ms: undefined,
    },
  );
  assert.ok(!Number.isNaN(Date.parse(meta.created_at)));
  assert.ok(Number.isInteger(meta.duration_ms) && meta.duration_ms >= 0);
});

test("generateImage: an edit's sidecar names its source and reference images", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  const seed = await generateImage({ prompt: "seed" });
  const src = path.join(root, "meta-src.png");
  const ref = path.join(root, "meta-ref.png");
  await fs.copyFile(seed.path, src);
  await fs.copyFile(seed.path, ref);
  await reset();

  const res = await generateImage({ prompt: "make it night", mode: "edit", images: [src, ref] });
  const meta = JSON.parse(await fs.readFile(res.metadataPath, "utf8"));
  assert.equal(meta.mode, "edit");
  assert.equal(meta.prompt, "make it night");
  assert.equal(meta.source_image, src);
  assert.deepEqual(meta.reference_images, [ref]);
  assert.equal(meta.requested_size, "auto");
});

test("generateImage: PIXMITH_METADATA=false writes no sidecar", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  config.writeMetadata = false;
  try {
    const res = await generateImage({ prompt: "a fox" });
    assert.equal(res.metadataPath, null);
    await assert.rejects(fs.access(res.path.replace(/\.png$/, ".json")));
  } finally {
    config.writeMetadata = true;
  }
});

test("writeMetadata: never overwrites, and a failure returns null instead of throwing", async () => {
  const png = path.join(root, "taken.png");
  const json = path.join(root, "taken.json");
  await fs.writeFile(json, "keep me");
  assert.equal(await writeMetadata(png, { prompt: "x" }), null);
  assert.equal(await fs.readFile(json, "utf8"), "keep me");
  assert.equal(await writeMetadata(path.join(root, "no-such-dir", "a.png"), { prompt: "x" }), null);
});

test("generateImage: a transparent background is asked for, and the PNG's alpha channel is reported", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  const plain = await generateImage({ prompt: "a logo", background: "transparent" });
  assert.equal(plain.background, "transparent");
  assert.equal(plain.hasAlpha, false, "the fake's default PNG has no alpha channel");
  const { stdin, promptFileText } = await lastCall();
  assert.match(stdin, /BACKGROUND: transparent/);
  assert.match(promptFileText, /Transparent background/);
  assert.equal(JSON.parse(await fs.readFile(plain.metadataPath, "utf8")).has_alpha, false);

  process.env.FAKE_COLOR_TYPE = "6";
  try {
    await reset();
    const rgba = await generateImage({ prompt: "a logo", background: "transparent" });
    assert.equal(rgba.hasAlpha, true);
  } finally {
    delete process.env.FAKE_COLOR_TYPE;
  }
  await assert.rejects(generateImage({ prompt: "a logo", background: "clear" }), (e) => e.kind === "bad_request");
});

test("generateImage: a chosen filename is used, and never overwrites", async () => {
  process.env.FAKE_MODE = "ok";
  const dir = path.join(root, "named");
  await reset();
  const first = await generateImage({ prompt: "a logo", outputDir: dir, filename: "Brand Logo" });
  assert.equal(first.path, path.join(dir, "Brand-Logo.png"));
  assert.equal(first.metadataPath, path.join(dir, "Brand-Logo.json"));

  await reset();
  const second = await generateImage({ prompt: "a logo", outputDir: dir, filename: "Brand Logo.png" });
  assert.equal(second.path, path.join(dir, "Brand-Logo-2.png"));

  // A name whose sidecar is already taken is skipped too, so the pair always matches.
  await fs.writeFile(path.join(dir, "Brand-Logo-3.json"), "{}");
  await reset();
  const third = await generateImage({ prompt: "a logo", outputDir: dir, filename: "Brand Logo" });
  assert.equal(third.path, path.join(dir, "Brand-Logo-4.png"));
  assert.notDeepEqual(await fs.readFile(first.path), Buffer.alloc(0), "the first file is untouched");

  await assert.rejects(generateImage({ prompt: "a logo", outputDir: dir, filename: "../escape" }), (e) => e.kind === "bad_request");
});

test("runCodexCommand + checkStatus: the real commands against the fake Codex", async () => {
  const version = await runCodexCommand(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /codex-cli 0\.99\.0-fake/);

  for (const [login, state] of [["chatgpt", "chatgpt"], ["apikey", "api_key"], ["out", "signed_out"], ["unsupported", "unknown"]]) {
    process.env.FAKE_LOGIN = login;
    try {
      const r = await checkStatus({ config });
      assert.equal(r.codex.version, "0.99.0-fake", login);
      assert.equal(r.sign_in.state, state, login);
    } finally {
      delete process.env.FAKE_LOGIN;
    }
  }

  const bin = config.codexBin;
  config.codexBin = path.join(root, "no-such-codex");
  try {
    const r = await checkStatus({ config });
    assert.equal(r.codex.found, false);
    assert.equal(r.problems[0].kind, "binary_missing");
  } finally {
    config.codexBin = bin;
  }
});

test("generateImage: an output_dir outside PIXMITH_ALLOWED_DIRS is refused before anything is created", async () => {
  process.env.FAKE_MODE = "ok";
  await reset();
  await fs.rm(path.join(codexHome, "last-call.json"), { force: true });
  const allowed = path.join(root, "allowed");
  config.allowedDirs = [allowed];
  try {
    const outside = path.join(root, "not-allowed", "sub");
    await assert.rejects(generateImage({ prompt: "a fox", outputDir: outside }), (e) => e.kind === "dir_not_allowed");
    await assert.rejects(fs.access(path.join(root, "not-allowed")), "the folder was not created");
    await assert.rejects(fs.access(path.join(codexHome, "last-call.json")), "Codex was never launched");

    const res = await generateImage({ prompt: "a fox", outputDir: path.join(allowed, "logos") });
    assert.equal(path.dirname(res.path), path.join(allowed, "logos"));
  } finally {
    config.allowedDirs = null;
  }
});
