import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A record of every finished image, so they can be listed later (list_images)
 * and collected after a server restart (get_image_result with an old job_id).
 * Images can be saved to any output_dir, so this index is how Pixmith finds
 * them again without scanning disks.
 *
 * Stored as JSON Lines in Pixmith's state dir, one image per line, oldest
 * first. The file is re-read on every lookup, so two Pixmith servers sharing a
 * state dir (e.g. Claude Desktop and Claude Code) see each other's images.
 * All I/O is best-effort: a history that cannot be read or written never
 * affects a job.
 */
export class ImageHistory {
  constructor({ file = null, maxEntries = 1000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.writing = Promise.resolve();
  }

  /** Append a finished job. Never rejects; resolves once written. */
  record(job) {
    if (!this.file || !job?.result?.path) return this.writing;
    const line = `${JSON.stringify(entryFromJob(job))}\n`;
    this.writing = this.writing.then(() => this.append(line));
    return this.writing;
  }

  async append(line) {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, line);
      // Trim only once well past the cap, so most appends stay a single write.
      const entries = await this.entries();
      if (entries.length > this.maxEntries * 1.5) await this.rewrite(entries.slice(-this.maxEntries));
    } catch {
      /* best-effort */
    }
  }

  async rewrite(entries) {
    const tmp = `${this.file}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
      await fs.rename(tmp, this.file);
    } catch {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /** Every readable entry, oldest first. Damaged lines are skipped. */
  async entries() {
    if (!this.file) return [];
    let text;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.path === "string" && typeof e.job_id === "string") out.push(e);
      } catch {
        /* skip a damaged line */
      }
    }
    return out;
  }

  /**
   * Images newest first, keeping only those whose PNG still exists. `query`
   * matches the prompt case-insensitively; `mode` is "generate" or "edit".
   * Returns { images, total } where total counts every match still on disk.
   */
  async list({ limit = 10, query = null, mode = null } = {}) {
    const needle = query ? query.toLowerCase() : null;
    const matches = (await this.entries())
      .reverse()
      .filter((e) => (!mode || e.mode === mode) && (!needle || String(e.prompt).toLowerCase().includes(needle)));
    const images = [];
    let total = 0;
    for (const e of matches) {
      if (!(await exists(e.path))) continue;
      total += 1;
      if (images.length < limit) images.push(e);
    }
    return { images, total };
  }

  /** The newest entry for `jobId`, or null. */
  async find(jobId) {
    const entries = await this.entries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].job_id === jobId) return entries[i];
    }
    return null;
  }
}

/** The history line for a finished job: enough to list it and to rebuild its result. */
export function entryFromJob(job) {
  const r = job.result;
  return {
    job_id: job.id,
    created_at: new Date(job.finishedAt ?? Date.now()).toISOString(),
    mode: job.mode,
    prompt: job.prompt,
    path: r.path,
    size: r.size,
    width: r.width ?? null,
    height: r.height ?? null,
    requested_size: r.requestedSize ?? null,
    size_note: r.sizeNote || null,
    bytes: r.bytes,
    input_images: r.inputImages ?? [],
    codex_copy: r.codexHomeCopy ?? null,
    session_id: r.sessionId ?? null,
    metadata_path: r.metadataPath ?? null,
    duration_ms: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null,
  };
}

/**
 * A finished job rebuilt from its history entry, shaped like a JobManager job
 * so the normal result formatting applies. Used after a server restart.
 */
export function jobFromEntry(e) {
  const finishedAt = Date.parse(e.created_at) || Date.now();
  return {
    id: e.job_id,
    mode: e.mode,
    prompt: e.prompt,
    status: "done",
    stage: null,
    queuedAt: finishedAt - (e.duration_ms ?? 0),
    startedAt: finishedAt - (e.duration_ms ?? 0),
    finishedAt,
    restored: true,
    result: {
      path: e.path,
      size: e.size,
      width: e.width,
      height: e.height,
      requestedSize: e.requested_size ?? undefined,
      sizeNote: e.size_note ?? "",
      bytes: e.bytes,
      inputImages: e.input_images ?? [],
      codexHomeCopy: e.codex_copy,
      sessionId: e.session_id,
      metadataPath: e.metadata_path,
    },
  };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
