import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PixmithError } from "../src/codex.js";
import { JobManager } from "../src/jobs.js";
import { createTools, formatError } from "../src/tools.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.alloc(64, 0),
]);

async function setup({ pollWaitMs = 60, generate } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-tools-"));
  const out = path.join(dir, "out.png");
  await fs.writeFile(out, PNG);
  const calls = [];
  const defaultGenerate = (args) =>
    new Promise((resolve, reject) => {
      calls.push({ args, resolve, reject });
      args.signal.addEventListener("abort", () => reject(new PixmithError("cancelled", "stopped")));
    });
  const jobs = new JobManager({ generate: generate ?? defaultGenerate });
  const config = { pollWaitMs, returnImage: true, maxInlineBytes: 1024 * 1024 };
  const { tools, call } = createTools({ jobs, config });
  const result = (extra = {}) => ({
    path: out,
    size: "1024x1024",
    requestedSize: "1024x1024",
    sizeNote: "",
    bytes: PNG.length,
    codexHomeCopy: null,
    inputImages: [],
    ...extra,
  });
  return { dir, out, jobs, tools, call, calls, result, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const jobIdOf = (res) => textOf(res).match(/job_id: (\S+)/)?.[1];

test("tools: the four tools are listed with schemas", async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.tools.map((x) => x.name), ["generate_image", "edit_image", "get_image_result", "cancel_image"]);
    assert.deepEqual(t.tools[1].inputSchema.required, ["image", "prompt"]);
    assert.equal(t.tools[2].inputSchema.required, undefined, "job_id is optional");
  } finally {
    await t.cleanup();
  }
});

test("generate_image: a fast job returns the image from the first call", async () => {
  const t = await setup({ pollWaitMs: 2000 });
  try {
    const pending = t.call("generate_image", { prompt: "a fox" });
    await new Promise((r) => setTimeout(r, 20));
    t.calls[0].resolve(t.result());
    const res = await pending;
    assert.equal(res.isError, undefined);
    assert.match(textOf(res), /status: done/);
    assert.match(textOf(res), /Image generated in \d+s/);
    assert.match(textOf(res), /call edit_image with image="/);
    assert.equal(res.content.at(-1).type, "image");
    assert.equal(res.content.at(-1).mimeType, "image/png");
  } finally {
    await t.cleanup();
  }
});

test("generate_image: a slow job reports its stage, then get_image_result (no job_id) collects it", async () => {
  const t = await setup({ pollWaitMs: 40 });
  try {
    const first = await t.call("generate_image", { prompt: "a fox", size: "1000x1000" });
    assert.match(textOf(first), /status: running/);
    assert.match(textOf(first), /stage: Starting Codex/);
    assert.match(textOf(first), /size_note: rounded 1000x1000 to 1008x1008/);
    assert.match(textOf(first), /typical: ~40s/);

    t.calls[0].args.onStage("rendering");
    const again = await t.call("get_image_result", { job_id: jobIdOf(first) });
    assert.match(textOf(again), /stage: Rendering the image/);

    t.calls[0].resolve(t.result());
    const done = await t.call("get_image_result", {});
    assert.match(textOf(done), /status: done/);
    // Results stay fetchable instead of being consumed by the first read.
    assert.match(textOf(await t.call("get_image_result", { job_id: jobIdOf(first) })), /status: done/);
  } finally {
    await t.cleanup();
  }
});

test("generate_image: wait=false returns at once; progress notifications carry stage and timing", async () => {
  const t = await setup({ pollWaitMs: 30 });
  try {
    const t0 = Date.now();
    const res = await t.call("generate_image", { prompt: "a fox", wait: false });
    assert.ok(Date.now() - t0 < 25);
    assert.match(textOf(res), /status: running/);

    const sent = [];
    const extra = { sendNotification: async (n) => sent.push(n.params) };
    await t.call("get_image_result", {}, { params: { _meta: { progressToken: "tok" } } }, extra);
    assert.ok(sent.length >= 1);
    assert.equal(sent[0].progressToken, "tok");
    assert.match(sent[0].message, /Starting Codex — \d+s of ~40s/);
    assert.ok(sent[0].total > sent[0].progress);
  } finally {
    await t.cleanup();
  }
});

test("edit_image: validates the source, runs in edit mode with image first, defaults size to auto", async () => {
  const t = await setup({ pollWaitMs: 2000 });
  try {
    const missing = await t.call("edit_image", { image: path.join(t.dir, "nope.png"), prompt: "x" });
    assert.match(textOf(missing), /\[bad_request\] Input image not found/);
    const relative = await t.call("edit_image", { image: "rel.png", prompt: "x" });
    assert.match(textOf(relative), /must be absolute/);
    const notImage = path.join(t.dir, "notes.png");
    await fs.writeFile(notImage, "just some text, definitely not an image");
    assert.match(textOf(await t.call("edit_image", { image: notImage, prompt: "x" })), /not a PNG, JPEG, WebP or GIF/);
    assert.match(textOf(await t.call("edit_image", { prompt: "x" })), /`image` is required/);
    assert.equal(t.calls.length, 0, "nothing reached the generator");

    const ref = path.join(t.dir, "ref.png");
    await fs.writeFile(ref, PNG);
    const pending = t.call("edit_image", { image: t.out, prompt: "make it night", reference_images: [ref] });
    await new Promise((r) => setTimeout(r, 20));
    const { args } = t.calls[0];
    assert.equal(args.mode, "edit");
    assert.equal(args.size, "auto");
    assert.deepEqual(args.images, [t.out, ref]);
    t.calls[0].resolve(t.result({ inputImages: [t.out, ref] }));
    const res = await pending;
    assert.match(textOf(res), /Image edited in/);
    assert.match(textOf(res), new RegExp(`Edited from: ${t.out.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
  } finally {
    await t.cleanup();
  }
});

test("cancel_image: stops the latest active job; later reads report cancelled", async () => {
  const t = await setup({ pollWaitMs: 30 });
  try {
    assert.match(textOf(await t.call("cancel_image", {})), /\[unknown_job\] There is no queued or running job/);

    const started = await t.call("generate_image", { prompt: "a fox", wait: false });
    const res = await t.call("cancel_image", {});
    assert.match(textOf(res), /status: cancelled/);
    assert.match(textOf(res), /running job was stopped/);
    assert.equal(t.calls[0].args.signal.aborted, true);

    const after = await t.call("get_image_result", { job_id: jobIdOf(started) });
    assert.match(textOf(after), /status: cancelled/);
    assert.equal(after.isError, undefined);
    assert.match(textOf(await t.call("cancel_image", { job_id: jobIdOf(started) })), /Nothing to cancel/);
  } finally {
    await t.cleanup();
  }
});

test("errors: bad arguments fail fast, failures carry a next step", async () => {
  const t = await setup({
    pollWaitMs: 500,
    generate: async () => {
      throw new PixmithError("usage_limit", "limit reached", "stderr tail");
    },
  });
  try {
    assert.match(textOf(await t.call("generate_image", { prompt: " " })), /\[bad_request\] `prompt` is required/);
    assert.match(textOf(await t.call("generate_image", { prompt: "x", size: "9999x9999" })), /Invalid `size`/);
    assert.match(textOf(await t.call("generate_image", { prompt: "x", output_dir: "rel" })), /absolute path/);
    assert.match(textOf(await t.call("generate_image", { prompt: "x", wait: "yes" })), /`wait` must be true or false/);
    assert.match(textOf(await t.call("get_image_result", { job_id: "nope" })), /\[unknown_job\]/);
    assert.match(textOf(await t.call("nope", {})), /Unknown tool/);

    const res = await t.call("generate_image", { prompt: "x" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /\[usage_limit\] limit reached\n\nNext step: .*\n\nDetail:\nstderr tail/);
    assert.equal(formatError(new Error("odd")), "Unexpected error: odd");
  } finally {
    await t.cleanup();
  }
});
