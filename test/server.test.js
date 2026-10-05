import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PixmithError } from "../src/codex.js";
import { ImageHistory } from "../src/history.js";
import { JobManager } from "../src/jobs.js";
import { createServer } from "../src/server.js";
import { CANCEL_OUTPUT_SCHEMA, JOB_OUTPUT_SCHEMA, LIST_OUTPUT_SCHEMA, STATUS_OUTPUT_SCHEMA } from "../src/tools.js";
import { noisyPng } from "../fixtures/noisy-png.js";

// End-to-end through a real MCP client. The SDK client checks every result's
// structuredContent against the tool's outputSchema and throws on a mismatch,
// so each call below is also a schema test.

const USAGE = {
  at: Date.now(),
  plan: "plus",
  windows: [{ label: "5-hour", minutes: 300, usedPercent: 85, resetsAt: Date.now() + 3_600_000 }],
  credits: { unlimited: false, balance: 0, available: false },
  reachedType: null,
};

async function connect({
  structuredOutput,
  pollWaitMs = 60,
  usage = USAGE,
  maxInlineBytes = 1024 * 1024,
  historyFile = null,
  runCodexCommand,
  configWarnings,
  allowedDirs = null,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-server-"));
  const png = path.join(dir, "out.png");
  await fs.writeFile(png, noisyPng(64, 48));
  const calls = [];
  const history = historyFile ? new ImageHistory({ file: historyFile }) : null;
  const jobs = new JobManager({
    history,
    generate: (args) =>
      new Promise((resolve, reject) => {
        calls.push({ args, resolve, reject });
        args.signal.addEventListener("abort", () => reject(new PixmithError("cancelled", "stopped")));
      }),
  });
  const config = {
    version: "test",
    pollWaitMs,
    finishGraceMs: 0,
    returnImage: true,
    maxInlineBytes,
    creditsPolicy: "ask",
    usageWarnPercent: 80,
    structuredOutput,
    // What pixmith_status reports on.
    codexBin: process.execPath,
    codexBinNote: null,
    codexHome: path.join(dir, "codex-home"),
    defaultOutputDir: path.join(dir, "images"),
    stateDir: path.join(dir, "state"),
    maxConcurrent: 1,
    timeoutMs: 300_000,
    sandbox: "workspace-write",
    bypassSandbox: false,
    allowedDirs: typeof allowedDirs === "function" ? allowedDirs(dir) : allowedDirs,
  };
  const server = createServer({ jobs, config, readUsage: async () => usage, history, runCodexCommand, configWarnings });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools(); // also primes the client's output validators
  const result = (extra = {}) => ({
    path: png,
    size: "64x48",
    width: 64,
    height: 48,
    requestedSize: "1024x1024",
    sizeNote: "",
    bytes: 1234,
    codexHomeCopy: "/codex/home/ig_1.png",
    inputImages: [],
    sessionId: "s1",
    metadataPath: "/abs/images/out.json",
    ...extra,
  });
  const callTool = (name, args = {}) => client.callTool({ name, arguments: args });
  const close = async () => {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { dir, png, tools, calls, result, callTool, close, history };
}

/** Every field the result carries must be declared in the schema (the client only checks declared ones). */
function assertDeclared(data, schema) {
  for (const key of Object.keys(data)) assert.ok(key in schema.properties, `"${key}" is not declared in the output schema`);
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("structured output: every tool declares an output schema", async () => {
  const t = await connect();
  try {
    const byName = Object.fromEntries(t.tools.map((tool) => [tool.name, tool]));
    for (const name of ["generate_image", "edit_image", "get_image_result"]) {
      assert.deepEqual(byName[name].outputSchema, JOB_OUTPUT_SCHEMA, name);
    }
    assert.deepEqual(byName.cancel_image.outputSchema, CANCEL_OUTPUT_SCHEMA);
    assert.deepEqual(byName.list_images.outputSchema, LIST_OUTPUT_SCHEMA);
    assert.deepEqual(byName.pixmith_status.outputSchema, STATUS_OUTPUT_SCHEMA);
  } finally {
    await t.close();
  }
});

test("structured output: a finished image carries its path, size, inline image and usage", async () => {
  const t = await connect({ pollWaitMs: 2000 });
  try {
    const pending = t.callTool("generate_image", { prompt: "a fox" });
    await tick();
    t.calls[0].resolve(t.result());
    const res = await pending;
    const data = res.structuredContent;
    assertDeclared(data, JOB_OUTPUT_SCHEMA);
    assert.equal(data.status, "done");
    assert.match(data.job_id, /^[0-9a-f-]{36}$/);
    assert.equal(data.mode, "generate");
    assert.equal(data.path, t.png);
    assert.deepEqual([data.size, data.width, data.height, data.requested_size, data.bytes], ["64x48", 64, 48, "1024x1024", 1234]);
    assert.equal(data.codex_copy, "/codex/home/ig_1.png");
    assert.equal(data.metadata_path, "/abs/images/out.json");
    assert.match(res.content[0].text, /^Metadata: \/abs\/images\/out\.json$/m);
    assert.equal(data.size_note, undefined, "an empty size note is left out");
    assert.equal(data.source_image, undefined);
    assert.deepEqual(data.inline_image, { mime_type: "image/png", width: 64, height: 48, preview: false });
    assert.equal(data.usage.plan, "plus");
    assert.equal(data.usage.near_limit, true);
    assert.deepEqual(data.usage.windows[0].label, "5-hour");
    assert.match(data.usage.windows[0].resets_at, /^\d{4}-\d\d-\d\dT/);
    // The text and the image are still there for the model.
    assert.match(res.content[0].text, /status: done/);
    assert.equal(res.content.at(-1).type, "image");
  } finally {
    await t.close();
  }
});

test("structured output: queued and running jobs, then collection with get_image_result", async () => {
  const t = await connect();
  try {
    const first = (await t.callTool("generate_image", { prompt: "one", wait: false, size: "1000x1000" })).structuredContent;
    const second = (await t.callTool("generate_image", { prompt: "two", wait: false })).structuredContent;
    assertDeclared(first, JOB_OUTPUT_SCHEMA);
    assert.equal(first.status, "running");
    assert.equal(first.size_note, "rounded 1000x1000 to 1008x1008 (each edge must be a multiple of 16)");
    assert.equal(typeof first.stage, "string");
    assert.ok(Number.isInteger(first.elapsed_seconds) && Number.isInteger(first.expected_seconds));
    assert.equal(second.status, "queued");
    assert.equal(second.queue_position, 1);

    t.calls[0].resolve(t.result());
    const done = (await t.callTool("get_image_result", { job_id: first.job_id })).structuredContent;
    assert.equal(done.status, "done");
    assert.equal(done.job_id, first.job_id);
  } finally {
    await t.close();
  }
});

test("structured output: an edit reports its source image", async () => {
  const t = await connect({ pollWaitMs: 2000 });
  try {
    const pending = t.callTool("edit_image", { image: t.png, prompt: "make it night" });
    await tick();
    t.calls[0].resolve(t.result({ inputImages: [t.png], metadataPath: null }));
    const data = (await pending).structuredContent;
    assert.equal(data.metadata_path, undefined, "no sidecar, no field");
    assert.equal(data.mode, "edit");
    assert.equal(data.source_image, t.png);
  } finally {
    await t.close();
  }
});

test("structured output: cancel_image reports what it did", async () => {
  const t = await connect();
  try {
    const running = (await t.callTool("generate_image", { prompt: "one", wait: false })).structuredContent;
    const queued = (await t.callTool("generate_image", { prompt: "two", wait: false })).structuredContent;

    const dropped = (await t.callTool("cancel_image", { job_id: queued.job_id })).structuredContent;
    assertDeclared(dropped, CANCEL_OUTPUT_SCHEMA);
    assert.deepEqual(dropped, { status: "cancelled", job_id: queued.job_id, cancel_requested: true, previous_status: "queued" });

    const stopped = (await t.callTool("cancel_image", { job_id: running.job_id })).structuredContent;
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.previous_status, "running");
    assert.ok(Number.isInteger(stopped.elapsed_seconds));

    const again = (await t.callTool("cancel_image", { job_id: running.job_id })).structuredContent;
    assert.deepEqual(again, { status: "cancelled", job_id: running.job_id, cancel_requested: false });

    const collected = (await t.callTool("get_image_result", { job_id: running.job_id })).structuredContent;
    assert.deepEqual(collected, { status: "cancelled", job_id: running.job_id, mode: "generate" });
  } finally {
    await t.close();
  }
});

test("structured output: failures carry a machine-readable kind and next step", async () => {
  const t = await connect();
  try {
    // Before any job exists.
    const bad = await t.callTool("generate_image", { prompt: "a fox", size: "10x10" });
    assert.equal(bad.isError, true);
    assertDeclared(bad.structuredContent, JOB_OUTPUT_SCHEMA);
    assert.equal(bad.structuredContent.status, "error");
    assert.equal(bad.structuredContent.job_id, undefined);
    assert.equal(bad.structuredContent.error.kind, "bad_request");
    assert.match(bad.structuredContent.error.message, /size/);

    const unknown = await t.callTool("cancel_image", { job_id: "nope" });
    assert.equal(unknown.structuredContent.error.kind, "unknown_job");

    // A job that fails.
    const started = (await t.callTool("generate_image", { prompt: "a fox", wait: false })).structuredContent;
    t.calls[0].reject(new PixmithError("usage_limit", "limit reached"));
    const failed = (await t.callTool("get_image_result", { job_id: started.job_id })).structuredContent;
    assert.equal(failed.status, "error");
    assert.equal(failed.job_id, started.job_id);
    assert.deepEqual(Object.keys(failed.error).sort(), ["kind", "message", "next_step"]);
    assert.equal(failed.error.kind, "usage_limit");
  } finally {
    await t.close();
  }
});

test("structured output: an image too big to inline is reported as not sent, and unknown usage as null", async () => {
  const t = await connect({ pollWaitMs: 2000, maxInlineBytes: 10, usage: null });
  try {
    const pending = t.callTool("generate_image", { prompt: "a fox" });
    await tick();
    t.calls[0].resolve(t.result());
    const data = (await pending).structuredContent;
    assert.equal(data.inline_image, null);
    assert.equal(data.usage, null);
  } finally {
    await t.close();
  }
});

test("structured output: PIXMITH_STRUCTURED_OUTPUT=false leaves the tools as they were", async () => {
  const t = await connect({ structuredOutput: false, pollWaitMs: 2000 });
  try {
    assert.ok(t.tools.every((tool) => tool.outputSchema === undefined));
    const pending = t.callTool("generate_image", { prompt: "a fox" });
    await tick();
    t.calls[0].resolve(t.result());
    const res = await pending;
    assert.equal(res.structuredContent, undefined);
    assert.match(res.content[0].text, /status: done/);
  } finally {
    await t.close();
  }
});

/** Run one job to completion through generate_image (or edit_image) and return its structured result. */
async function finish(t, tool, args, result) {
  const started = (await t.callTool(tool, { ...args, wait: false })).structuredContent;
  t.calls.at(-1).resolve(result);
  const done = (await t.callTool("get_image_result", { job_id: started.job_id })).structuredContent;
  await t.history.writing;
  return done;
}

test("list_images: earlier images, newest first, filtered by prompt and mode", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-state-"));
  const t = await connect({ historyFile: path.join(state, "history.jsonl") });
  try {
    const fox = await finish(t, "generate_image", { prompt: "a red fox" }, t.result());
    const whale = await finish(t, "generate_image", { prompt: "a blue whale" }, t.result());
    const night = await finish(t, "edit_image", { image: t.png, prompt: "make the FOX night" }, t.result({ inputImages: [t.png] }));

    const res = await t.callTool("list_images");
    const data = res.structuredContent;
    assertDeclared(data, LIST_OUTPUT_SCHEMA);
    data.images.forEach((img) => assertDeclared(img, LIST_OUTPUT_SCHEMA.properties.images.items));
    assert.equal(data.status, "ok");
    assert.equal(data.total, 3);
    assert.deepEqual(data.images.map((i) => i.job_id), [night.job_id, whale.job_id, fox.job_id]);
    assert.deepEqual(
      { ...data.images[0], created_at: undefined },
      {
        path: t.png,
        job_id: night.job_id,
        created_at: undefined,
        mode: "edit",
        prompt: "make the FOX night",
        size: "64x48",
        width: 64,
        height: 48,
        source_image: t.png,
        metadata_path: "/abs/images/out.json",
      },
    );
    const text = res.content[0].text;
    assert.match(text, /^3 images:/);
    assert.match(text, /^1\. \d{4}-\d\d-\d\d \d\d:\d\d UTC · edited · 64x48$/m);
    assert.match(text, new RegExp(`^   job_id: ${fox.job_id}$`, "m"));

    const foxes = (await t.callTool("list_images", { query: "fox", limit: 1 })).structuredContent;
    assert.deepEqual([foxes.total, foxes.images.map((i) => i.job_id)], [2, [night.job_id]]);
    assert.match((await t.callTool("list_images", { query: "fox", limit: 1 })).content[0].text, /^2 images \(matching "fox"\), showing the newest 1:/);
    const generated = (await t.callTool("list_images", { mode: "generate" })).structuredContent;
    assert.deepEqual(generated.images.map((i) => i.job_id), [whale.job_id, fox.job_id]);

    const none = await t.callTool("list_images", { query: "zebra" });
    assert.deepEqual(none.structuredContent, { status: "ok", images: [], total: 0 });
    assert.equal(none.content[0].text, 'No images found (matching "zebra").');

    const bad = await t.callTool("list_images", { limit: 0 });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.kind, "bad_request");
  } finally {
    await t.close();
    await fs.rm(state, { recursive: true, force: true });
  }
});

test("get_image_result: a finished image can still be collected after a restart", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-state-"));
  const historyFile = path.join(state, "history.jsonl");
  const png = path.join(state, "kept.png");
  await fs.writeFile(png, noisyPng(64, 48));
  const before = await connect({ historyFile });
  let jobId;
  try {
    jobId = (await finish(before, "generate_image", { prompt: "a fox" }, before.result({ path: png }))).job_id;
  } finally {
    await before.close();
  }

  const after = await connect({ historyFile }); // a fresh server: no jobs in memory
  try {
    const res = await after.callTool("get_image_result", { job_id: jobId });
    const data = res.structuredContent;
    assert.equal(data.status, "done");
    assert.equal(data.job_id, jobId);
    assert.equal(data.path, png);
    assert.equal(data.usage, null, "usage from today would not describe that job");
    assert.equal(res.content.at(-1).type, "image");
    assert.doesNotMatch(res.content[0].text, /Plan usage/);

    const cancel = (await after.callTool("cancel_image", { job_id: jobId })).structuredContent;
    assert.deepEqual(cancel, { status: "done", job_id: jobId, cancel_requested: false });

    const unknown = await after.callTool("get_image_result", { job_id: "never-existed" });
    assert.equal(unknown.structuredContent.error.kind, "unknown_job");
    assert.match(unknown.content[0].text, /list_images/);
  } finally {
    await after.close();
    await fs.rm(state, { recursive: true, force: true });
  }
});

/**
 * Resolve (or reject, for an Error) the next jobs in order as they start. Jobs
 * run one at a time, so each call appears only after the one before settles.
 */
async function settleInOrder(t, outcomes) {
  for (const outcome of outcomes) {
    const i = (t.settled = (t.settled ?? 0) + 1) - 1;
    while (t.calls.length <= i) await tick(5);
    if (outcome instanceof Error) t.calls[i].reject(outcome);
    else t.calls[i].resolve(outcome);
  }
}

test("variants: one call starts several jobs and returns them together, sharing the inline budget", async () => {
  // The 64x48 PNG fits the budget alone, but not three times over.
  const t = await connect({ pollWaitMs: 3000, maxInlineBytes: 20_000 });
  try {
    const pending = t.callTool("generate_image", { prompt: "a fox", variants: 3, filename: "fox" });
    await settleInOrder(t, [t.result(), t.result(), t.result()]);
    const res = await pending;
    const data = res.structuredContent;
    assertDeclared(data, JOB_OUTPUT_SCHEMA);
    assert.equal(data.status, "done");
    assert.equal(data.job_id, undefined);
    assert.equal(data.job_ids.length, 3);
    assert.deepEqual(data.variants.map((v) => [v.status, v.job_id]), data.job_ids.map((id) => ["done", id]));
    assert.ok(data.variants.every((v) => v.inline_image.preview), "each variant's preview is shrunk to its slice");
    assert.equal(data.usage.plan, "plus");
    assert.deepEqual(t.calls.map((c) => c.args.filename), ["fox-1", "fox-2", "fox-3"]);

    assert.equal(res.content.filter((c) => c.type === "image").length, 3);
    const text = res.content[0].text;
    assert.match(text, /^status: done\nVariants: 3 of 3 done\.$/m);
    assert.match(text, /^Variant 2 of 3:$/m);
    assert.equal(text.match(/Plan usage/g).length, 1, "usage is reported once for the batch");
    assert.match(text, /To change a variant, call edit_image with its Path/);
  } finally {
    await t.close();
  }
});

test("variants: partial results, failures, and collecting each variant on its own", async () => {
  const t = await connect({ pollWaitMs: 3000 });
  try {
    const started = (await t.callTool("generate_image", { prompt: "a fox", variants: 2, wait: false })).structuredContent;
    assert.equal(started.status, "running");
    assert.deepEqual(started.variants.map((v) => v.status), ["running", "queued"]);

    await settleInOrder(t, [new PixmithError("generation_failed", "refused"), t.result()]);
    const second = (await t.callTool("get_image_result", { job_id: started.job_ids[1] })).structuredContent;
    assert.equal(second.status, "done");

    // A batch with one failure is still a success overall.
    const mixed = t.callTool("generate_image", { prompt: "a fox", variants: 2 });
    await settleInOrder(t, [new PixmithError("generation_failed", "refused"), t.result()]);
    const res = await mixed;
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.status, "done");
    assert.equal(res.structuredContent.variants[0].error.kind, "generation_failed");
    assert.match(res.content[0].text, /^Variants: 1 of 2 done, 1 failed\.$/m);
    assert.match(res.content[0].text, /\[generation_failed\] refused/);

    // When every variant fails, the call is an error.
    const failing = t.callTool("generate_image", { prompt: "a fox", variants: 2 });
    await settleInOrder(t, [new PixmithError("timeout", "slow"), new PixmithError("timeout", "slow")]);
    const allFailed = await failing;
    assert.equal(allFailed.isError, true);
    assert.equal(allFailed.structuredContent.status, "error");
  } finally {
    await t.close();
  }
});

test("background: the option reaches the job, and a missing alpha channel is reported", async () => {
  const t = await connect({ pollWaitMs: 2000, maxInlineBytes: 5000 });
  try {
    const pending = t.callTool("generate_image", { prompt: "a logo", background: "transparent" });
    await settleInOrder(t, [t.result({ background: "transparent", hasAlpha: false })]);
    const res = await pending;
    assert.equal(t.calls[0].args.background, "transparent");
    assert.equal(res.structuredContent.background, "transparent");
    assert.equal(res.structuredContent.has_alpha, false);
    assert.match(res.content[0].text, /transparency was asked for, but the PNG has no alpha channel/);

    const ok = t.callTool("generate_image", { prompt: "a logo", background: "transparent" });
    await settleInOrder(t, [t.result({ background: "transparent", hasAlpha: true })]);
    const text = (await ok).content[0].text;
    assert.match(text, /^Background: transparent \(the PNG has an alpha channel\)\.$/m);
    assert.match(text, /Transparent areas show as white in it\./, "the JPEG preview cannot show transparency");
  } finally {
    await t.close();
  }
});

test("generation options: bad values are refused before any job starts", async () => {
  const t = await connect();
  try {
    for (const args of [{ variants: 5 }, { variants: 1.5 }, { background: "clear" }, { filename: "a/b" }, { filename: "!!!" }]) {
      const res = await t.callTool("generate_image", { prompt: "a fox", ...args });
      assert.equal(res.structuredContent.error.kind, "bad_request", JSON.stringify(args));
    }
    assert.equal(t.calls.length, 0);
  } finally {
    await t.close();
  }
});

test("pixmith_status: reports readiness, and each problem with its next step", async () => {
  const fakeCodex = (login) => async (args) =>
    args[0] === "--version"
      ? { code: 0, stdout: "codex-cli 0.46.0\n", stderr: "", error: null }
      : { code: login === "out" ? 1 : 0, stdout: "", stderr: login === "out" ? "Not logged in\n" : "Logged in using ChatGPT\n", error: null };

  const ready = await connect({ runCodexCommand: fakeCodex("chatgpt") });
  try {
    const res = await ready.callTool("pixmith_status");
    const data = res.structuredContent;
    assertDeclared(data, STATUS_OUTPUT_SCHEMA);
    assert.equal(data.status, "ready");
    assert.equal(data.codex.version, "0.46.0");
    assert.equal(data.sign_in.state, "chatgpt");
    assert.equal(data.usage.plan, "plus");
    assert.deepEqual(data.jobs, { running: 0, queued: 0 });
    const text = res.content[0].text;
    assert.match(text, /^Pixmith test: ready to make images\.$/m);
    assert.match(text, /^Codex: version 0\.46\.0 at /m);
    assert.match(text, /^Signed in: yes, with a ChatGPT account$/m);
    assert.match(text, /^Plan usage: 85% of the 5-hour limit/m);
    assert.match(text, /^Settings: up to 1 job at a time, 0s wait window, 300s timeout, sandbox workspace-write, credits policy "ask"$/m);
    assert.doesNotMatch(text, /Problems:|Warnings:/);
  } finally {
    await ready.close();
  }

  const broken = await connect({ runCodexCommand: fakeCodex("out"), usage: null, configWarnings: ["PIXMITH_X was ignored."] });
  try {
    const res = await broken.callTool("pixmith_status");
    assert.equal(res.isError, undefined, "a problem found is a result, not a failed call");
    assert.equal(res.structuredContent.status, "problems");
    assert.equal(res.structuredContent.usage, null);
    const text = res.content[0].text;
    assert.match(text, /^Pixmith test: 1 problem found\.$/m);
    assert.match(text, /^- Codex is not signed in\. Next step: Run `codex login`/m);
    assert.match(text, /^Plan usage: no recent figures/m);
    assert.match(text, /^Warnings:\n- PIXMITH_X was ignored\.$/m);
  } finally {
    await broken.close();
  }
});

test("allowed folders: output_dir outside them is refused before any job, and the tools say which are allowed", async () => {
  const fakeCodex = async (args) =>
    args[0] === "--version"
      ? { code: 0, stdout: "codex-cli 0.46.0", stderr: "", error: null }
      : { code: 0, stdout: "", stderr: "Logged in using ChatGPT", error: null };
  const t = await connect({ allowedDirs: (dir) => [path.join(dir, "allowed")], runCodexCommand: fakeCodex, pollWaitMs: 2000 });
  try {
    const allowed = path.join(t.dir, "allowed");
    const description = t.tools.find((tool) => tool.name === "generate_image").inputSchema.properties.output_dir.description;
    assert.ok(description.endsWith(` Must be inside one of: ${path.join(t.dir, "images")}, ${allowed} (PIXMITH_ALLOWED_DIRS).`));

    const refused = await t.callTool("generate_image", { prompt: "a fox", output_dir: path.join(t.dir, "elsewhere") });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.kind, "dir_not_allowed");
    assert.match(refused.structuredContent.error.next_step, /PIXMITH_ALLOWED_DIRS/);
    assert.equal(t.calls.length, 0, "no job was started");

    const pending = t.callTool("generate_image", { prompt: "a fox", output_dir: path.join(allowed, "sub") });
    await settleInOrder(t, [t.result()]);
    assert.equal((await pending).structuredContent.status, "done");
    assert.equal(t.calls[0].args.outputDir, path.join(allowed, "sub"));

    const status = await t.callTool("pixmith_status");
    assert.deepEqual(status.structuredContent.settings.allowed_dirs, [path.join(t.dir, "images"), allowed]);
    assert.match(status.content[0].text, new RegExp(`^Folders output_dir may use: .*${allowed.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`, "m"));
  } finally {
    await t.close();
  }
});

test("pixmith_status: points out Codex's duplicate copies and how to delete them", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-state-"));
  const historyFile = path.join(state, "history.jsonl");
  const copy = path.join(state, "ig_1.png");
  await fs.writeFile(copy, "12345");
  await fs.writeFile(historyFile, `${JSON.stringify({ job_id: "j1", path: path.join(state, "own.png"), codex_copy: copy })}\n`);
  const fakeCodex = async (args) =>
    args[0] === "--version" ? { code: 0, stdout: "codex-cli 0.46.0", stderr: "", error: null } : { code: 0, stdout: "", stderr: "Logged in using ChatGPT", error: null };
  const t = await connect({ historyFile, runCodexCommand: fakeCodex });
  try {
    const res = await t.callTool("pixmith_status");
    assert.deepEqual(res.structuredContent.codex_copies, { count: 1, bytes: 5, policy: "keep" });
    assert.match(
      res.content[0].text,
      /^Codex's duplicate copies: 1 image, 5 bytes under CODEX_HOME\. Run `npx pixmith prune-codex-copies` .* or set PIXMITH_CODEX_COPIES=remove so new ones are not kept\.$/m,
    );
  } finally {
    await t.close();
    await fs.rm(state, { recursive: true, force: true });
  }
});
