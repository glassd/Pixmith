import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ImageHistory, entryFromJob, jobFromEntry } from "../src/history.js";
import { JobManager } from "../src/jobs.js";

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-history-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A finished job as JobManager leaves it, with a real PNG file on disk. */
async function finishedJob(dir, n, { mode = "generate", prompt = `image ${n}`, finishedAt = Date.UTC(2026, 9, 5, 12, n) } = {}) {
  const file = path.join(dir, `img-${n}.png`);
  await fs.writeFile(file, "png");
  return {
    id: `job-${n}`,
    mode,
    prompt,
    startedAt: finishedAt - 30_000,
    finishedAt,
    result: {
      path: file,
      size: "1024x1024",
      width: 1024,
      height: 1024,
      requestedSize: "1024x1024",
      sizeNote: "",
      bytes: 3,
      inputImages: mode === "edit" ? ["/src.png", "/ref.png"] : [],
      codexHomeCopy: "/codex/ig.png",
      sessionId: `s-${n}`,
      metadataPath: file.replace(/\.png$/, ".json"),
    },
  };
}

test("ImageHistory: lists newest first, filters by prompt and mode, and skips deleted images", () =>
  withDir(async (dir) => {
    const history = new ImageHistory({ file: path.join(dir, "state", "history.jsonl") });
    assert.deepEqual(await history.list(), { images: [], total: 0 }, "no file yet");

    await history.record(await finishedJob(dir, 1, { prompt: "A red Fox" }));
    await history.record(await finishedJob(dir, 2, { prompt: "a blue whale" }));
    await history.record(await finishedJob(dir, 3, { prompt: "make the fox night", mode: "edit" }));
    await history.record(await finishedJob(dir, 4, { prompt: "a fox, deleted later" }));
    await fs.rm(path.join(dir, "img-4.png"));

    const all = await history.list();
    assert.deepEqual(all.images.map((e) => e.job_id), ["job-3", "job-2", "job-1"]);
    assert.equal(all.total, 3, "a deleted image is not counted");

    assert.deepEqual((await history.list({ query: "FOX" })).images.map((e) => e.job_id), ["job-3", "job-1"]);
    assert.deepEqual((await history.list({ mode: "edit" })).images.map((e) => e.job_id), ["job-3"]);
    const limited = await history.list({ limit: 1 });
    assert.deepEqual([limited.images.map((e) => e.job_id), limited.total], [["job-3"], 3]);
  }));

test("ImageHistory: find returns the newest entry for a job, and damaged lines are skipped", () =>
  withDir(async (dir) => {
    const file = path.join(dir, "history.jsonl");
    const history = new ImageHistory({ file });
    await history.record(await finishedJob(dir, 1));
    await fs.appendFile(file, "not json\n{\"no\":\"path\"}\n");
    await history.record(await finishedJob(dir, 2));

    assert.equal((await history.entries()).length, 2);
    assert.equal((await history.find("job-2")).path, path.join(dir, "img-2.png"));
    assert.equal(await history.find("nope"), null);
  }));

test("ImageHistory: trims to the newest maxEntries once well past the cap", () =>
  withDir(async (dir) => {
    const history = new ImageHistory({ file: path.join(dir, "history.jsonl"), maxEntries: 4 });
    for (let n = 1; n <= 6; n += 1) history.record(await finishedJob(dir, n));
    await history.writing;
    assert.equal((await history.entries()).length, 6, "up to 1.5x the cap is kept untrimmed");
    await history.record(await finishedJob(dir, 7));
    assert.deepEqual((await history.entries()).map((e) => e.job_id), ["job-4", "job-5", "job-6", "job-7"]);
    assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")), [], "no temporary files are left behind");
  }));

test("ImageHistory: without a file, or with an unwritable one, nothing fails", () =>
  withDir(async (dir) => {
    const job = await finishedJob(dir, 1);
    const none = new ImageHistory();
    await none.record(job);
    assert.deepEqual(await none.list(), { images: [], total: 0 });

    await fs.writeFile(path.join(dir, "blocker"), "a file, not a folder");
    const broken = new ImageHistory({ file: path.join(dir, "blocker", "history.jsonl") });
    await broken.record(job);
    assert.deepEqual(await broken.list(), { images: [], total: 0 });
  }));

test("entryFromJob / jobFromEntry: a finished job survives the round trip", () =>
  withDir(async (dir) => {
    const job = await finishedJob(dir, 1, { mode: "edit", prompt: "make it night" });
    const entry = JSON.parse(JSON.stringify(entryFromJob(job)));
    assert.equal(entry.created_at, "2026-10-05T12:01:00.000Z");
    assert.equal(entry.duration_ms, 30_000);

    const back = jobFromEntry(entry);
    assert.deepEqual(
      { id: back.id, mode: back.mode, prompt: back.prompt, status: back.status, restored: back.restored },
      { id: "job-1", mode: "edit", prompt: "make it night", status: "done", restored: true },
    );
    assert.equal(back.finishedAt - back.startedAt, 30_000);
    assert.deepEqual(back.result, job.result);
  }));

test("JobManager: a finished job is recorded in the history; a failed one is not", async () => {
  const recorded = [];
  let n = 0;
  const jobs = new JobManager({
    generate: async () => {
      n += 1;
      if (n === 2) throw new Error("boom");
      return { path: "/out/a.png" };
    },
    history: { record: (job) => recorded.push(job) },
  });
  const ok = jobs.create({ prompt: "a" });
  await ok.settled;
  const bad = jobs.create({ prompt: "b" });
  await bad.settled;
  assert.deepEqual(recorded.map((j) => [j.id, j.status]), [[ok.id, "done"]]);
});
