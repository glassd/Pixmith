import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Remembers how long recent jobs took so Pixmith can tell the user what to
 * expect ("about 12s left") instead of a fixed guess. Durations are kept per
 * mode, the estimate is their median, and the history survives restarts in a
 * small JSON file. All file I/O is best-effort: a read-only disk just means
 * the defaults are used.
 */
export class DurationStats {
  constructor({ file = null, defaults = { generate: 40_000, edit: 70_000 }, keep = 10 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.keep = keep;
    this.samples = {};
    if (file) {
      try {
        const data = JSON.parse(fssync.readFileSync(file, "utf8"));
        for (const [mode, list] of Object.entries(data?.samples ?? {})) {
          if (Array.isArray(list)) {
            this.samples[mode] = list.filter((n) => Number.isFinite(n) && n > 0).slice(-keep);
          }
        }
      } catch {
        /* no history yet */
      }
    }
  }

  record(mode, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const list = (this.samples[mode] ??= []);
    list.push(Math.round(ms));
    while (list.length > this.keep) list.shift();
    if (!this.file) return;
    fs.mkdir(path.dirname(this.file), { recursive: true })
      .then(() => fs.writeFile(this.file, JSON.stringify({ samples: this.samples })))
      .catch(() => {});
  }

  /** Median of the recent durations for `mode`, or the default when there is no history. */
  estimate(mode) {
    const list = this.samples[mode];
    if (!list || !list.length) return this.defaults[mode] ?? this.defaults.generate;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
}

const ACTIVE = new Set(["queued", "running"]);

/**
 * FIFO job queue. At most `maxConcurrent` jobs run at once; the rest wait with
 * status "queued". Every job owns an AbortController, so it can be cancelled
 * whether it is still queued or already running. Finished jobs are kept for
 * `ttlMs` so a result can be fetched again (or after a client-side timeout).
 *
 * `generate` is injected (src/codex.js `generateImage` in production), which
 * keeps this module free of Codex and easy to test.
 */
export class JobManager {
  constructor({ generate, maxConcurrent = 1, ttlMs = 15 * 60 * 1000, stats = new DurationStats(), log = () => {} }) {
    this.generate = generate;
    this.maxConcurrent = maxConcurrent;
    this.ttlMs = ttlMs;
    this.stats = stats;
    this.log = log;
    this.jobs = new Map(); // insertion order == creation order
    this.queue = [];
    this.running = 0;
  }

  create({ prompt, size, outputDir, images = [], mode = "generate" }) {
    this.prune();
    let resolveSettled;
    const settled = new Promise((r) => {
      resolveSettled = r;
    });
    const job = {
      id: randomUUID(),
      mode,
      prompt,
      size,
      outputDir,
      images,
      status: "queued",
      stage: null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      controller: new AbortController(),
      settled,
      resolveSettled,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  /** The most recently created job, optionally only one that is still queued/running. */
  latest({ activeOnly = false } = {}) {
    const all = [...this.jobs.values()].reverse();
    return all.find((j) => !activeOnly || ACTIVE.has(j.status)) ?? null;
  }

  isActive(job) {
    return ACTIVE.has(job.status);
  }

  queuePosition(id) {
    const i = this.queue.indexOf(id);
    return i === -1 ? 0 : i + 1;
  }

  elapsedMs(job) {
    return (job.finishedAt ?? Date.now()) - (job.startedAt ?? job.queuedAt);
  }

  /** Expected total run time for this job's mode, from recent history. */
  etaMs(job) {
    return this.stats.estimate(job.mode);
  }

  /** Rough milliseconds left for a running job; never less than 1s while it is still going. */
  remainingMs(job) {
    return Math.max(1000, this.etaMs(job) - this.elapsedMs(job));
  }

  /** Wait until the job settles, `ms` elapse, or `signal` aborts — whichever comes first. */
  async wait(job, ms, signal) {
    if (!this.isActive(job) || ms <= 0) return;
    let timer;
    let onAbort;
    const window = new Promise((r) => {
      timer = setTimeout(r, ms);
      if (signal) {
        onAbort = () => r();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      await Promise.race([job.settled, window]);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Cancel a job. A queued job is dropped at once; a running job has its Codex
   * session killed, and we wait briefly for that to land. Returns the status
   * the job had before the call ("queued" | "running"), or null when the job
   * had already finished.
   */
  async cancel(job, { graceMs = 5000 } = {}) {
    if (!this.isActive(job)) return null;
    const was = job.status;
    if (was === "queued") {
      const i = this.queue.indexOf(job.id);
      if (i !== -1) this.queue.splice(i, 1);
      this.finish(job, "cancelled");
      return was;
    }
    job.controller.abort();
    await this.wait(job, graceMs);
    return was;
  }

  /** Abort everything (server shutdown). */
  shutdown() {
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      if (this.isActive(job)) job.controller.abort();
    }
  }

  finish(job, status) {
    job.status = status;
    job.finishedAt = Date.now();
    job.resolveSettled();
  }

  prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > this.ttlMs) this.jobs.delete(id);
    }
  }

  pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const job = this.jobs.get(this.queue.shift());
      if (!job || job.status !== "queued") continue;

      this.running += 1;
      job.status = "running";
      job.stage = "starting";
      job.startedAt = Date.now();

      Promise.resolve()
        .then(() =>
          this.generate({
            prompt: job.prompt,
            size: job.size,
            outputDir: job.outputDir,
            images: job.images,
            mode: job.mode,
            signal: job.controller.signal,
            onStage: (stage) => {
              job.stage = stage;
            },
            onProgress: (line) => this.log(job, line),
          }),
        )
        .then((result) => {
          job.result = result;
          this.stats.record(job.mode, Date.now() - job.startedAt);
          this.finish(job, "done");
        })
        .catch((err) => {
          job.error = err;
          this.finish(job, err?.kind === "cancelled" || job.controller.signal.aborted ? "cancelled" : "error");
        })
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }
}
