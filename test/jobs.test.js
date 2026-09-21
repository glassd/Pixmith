import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DurationStats, JobManager } from "../src/jobs.js";

/** A generator the test controls: each call parks until resolved, rejected, or aborted. */
function fakeGenerator() {
  const calls = [];
  const generate = (args) =>
    new Promise((resolve, reject) => {
      const call = { args, resolve, reject };
      calls.push(call);
      args.signal.addEventListener("abort", () => {
        const err = new Error("cancelled");
        err.kind = "cancelled";
        reject(err);
      });
    });
  return { generate, calls };
}

const tick = () => new Promise((r) => setImmediate(r));

test("DurationStats: default, median, rolling window, persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-stats-"));
  try {
    const file = path.join(dir, "nested", "stats.json");
    const stats = new DurationStats({ file, keep: 3, defaults: { generate: 40_000, edit: 50_000 } });
    assert.equal(stats.estimate("generate"), 40_000);
    assert.equal(stats.estimate("edit"), 50_000);

    for (const ms of [10_000, 90_000, 30_000, 32_000]) stats.record("generate", ms);
    assert.equal(stats.estimate("generate"), 32_000); // window of 3: 90, 30, 32 -> median 32
    stats.record("generate", -5); // ignored
    stats.record("generate", Number.NaN); // ignored
    assert.equal(stats.estimate("generate"), 32_000);

    // The write is fire-and-forget; give it a moment, then reload.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(new DurationStats({ file, keep: 3 }).estimate("generate"), 32_000);
    // A corrupt or missing file falls back to defaults.
    await fs.writeFile(file, "not json");
    assert.equal(new DurationStats({ file }).estimate("generate"), 40_000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("JobManager: runs FIFO up to maxConcurrent and records durations", async () => {
  const { generate, calls } = fakeGenerator();
  const jobs = new JobManager({ generate, maxConcurrent: 1 });
  const a = jobs.create({ prompt: "a" });
  const b = jobs.create({ prompt: "b", mode: "edit", images: ["/x.png"] });
  await tick();

  assert.equal(a.status, "running");
  assert.equal(b.status, "queued");
  assert.equal(jobs.queuePosition(b.id), 1);
  assert.equal(calls.length, 1);
  assert.equal(jobs.latest().id, b.id);
  assert.equal(jobs.latest({ activeOnly: true }).id, b.id);

  calls[0].args.onStage("rendering");
  assert.equal(a.stage, "rendering");
  calls[0].resolve({ path: "/out/a.png" });
  await a.settled;
  await tick();

  assert.equal(a.status, "done");
  assert.deepEqual(a.result, { path: "/out/a.png" });
  assert.equal(b.status, "running");
  assert.deepEqual(calls[1].args.images, ["/x.png"]);
  assert.equal(calls[1].args.mode, "edit");

  calls[1].reject(Object.assign(new Error("boom"), { kind: "no_output" }));
  await b.settled;
  assert.equal(b.status, "error");
  assert.equal(b.error.kind, "no_output");
});

test("JobManager: cancel drops a queued job and aborts a running one", async () => {
  const { generate, calls } = fakeGenerator();
  const jobs = new JobManager({ generate, maxConcurrent: 1 });
  const running = jobs.create({ prompt: "a" });
  const queued = jobs.create({ prompt: "b" });
  await tick();

  assert.equal(await jobs.cancel(queued), "queued");
  assert.equal(queued.status, "cancelled");
  assert.equal(jobs.queuePosition(queued.id), 0);

  assert.equal(await jobs.cancel(running), "running");
  assert.equal(running.status, "cancelled");
  assert.equal(calls.length, 1, "the cancelled queued job never started");

  // Cancelling again is a no-op; a cancelled run is not recorded as a duration.
  assert.equal(await jobs.cancel(running), null);
  assert.equal(jobs.stats.samples.generate, undefined);

  // The slot is free again.
  const next = jobs.create({ prompt: "c" });
  await tick();
  assert.equal(next.status, "running");
  jobs.shutdown();
  await next.settled;
  assert.equal(next.status, "cancelled");
});

test("JobManager: wait returns when the job settles, the window ends, or the signal aborts", async () => {
  const { generate, calls } = fakeGenerator();
  const jobs = new JobManager({ generate });
  const job = jobs.create({ prompt: "a" });
  await tick();

  let t0 = Date.now();
  await jobs.wait(job, 40);
  assert.ok(Date.now() - t0 >= 30 && job.status === "running");

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  t0 = Date.now();
  await jobs.wait(job, 5000, ac.signal);
  assert.ok(Date.now() - t0 < 1000);

  setTimeout(() => calls[0].resolve({ path: "/p.png" }), 20);
  t0 = Date.now();
  await jobs.wait(job, 5000);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(job.status, "done");
});

test("JobManager: finished jobs expire after the TTL", async () => {
  const { generate, calls } = fakeGenerator();
  const jobs = new JobManager({ generate, ttlMs: 10 });
  const job = jobs.create({ prompt: "a" });
  await tick();
  calls[0].resolve({ path: "/p.png" });
  await job.settled;
  assert.ok(jobs.get(job.id));
  await new Promise((r) => setTimeout(r, 25));
  jobs.prune();
  assert.equal(jobs.get(job.id), null);
});
