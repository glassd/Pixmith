import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeSize } from "./config.js";
import { PixmithError, STAGE_LABELS, validateInputImages, MAX_INPUT_IMAGES } from "./codex.js";
import { makeInlineImage } from "./preview.js";
import { creditGate, readUsage as readCodexUsage, usageLines, usageSummary } from "./usage.js";

// Pixmith's MCP tool layer. A generation outlives the per-request timeout some
// MCP clients enforce, so no tool call ever blocks for longer than
// config.pollWaitMs:
//
//   generate_image / edit_image  start a job and wait up to the window. A
//                                typical image finishes inside it, so the
//                                common case is ONE call that returns the image.
//                                (A job caught in its final stage when the
//                                window closes gets config.finishGraceMs more.)
//   get_image_result             picks up a job that needed longer (job_id
//                                optional — defaults to the latest job).
//   cancel_image                 stops a queued or running job.
//
// While a call waits, progress notifications carry the real stage reported by
// Codex plus elapsed / expected time, for clients that display them.
//
// Every result also carries structuredContent matching the tool's outputSchema
// (unless PIXMITH_STRUCTURED_OUTPUT=false), so a client can read the status,
// path and job_id without parsing text. The text and the inline image stay in
// `content` for the model and for clients without structured output.

const ERROR_SCHEMA = {
  type: "object",
  description: 'Why the call or job failed. Present when status is "error".',
  properties: {
    kind: {
      type: "string",
      description: "Machine-readable kind, e.g. bad_request, usage_limit, credits_confirmation_needed, not_signed_in, timeout, generation_failed.",
    },
    message: { type: "string" },
    next_step: { type: "string", description: "What the user can do about it." },
  },
  required: ["kind", "message"],
};

const USAGE_SCHEMA = {
  type: ["object", "null"],
  description: "The ChatGPT plan's Codex usage when the job finished; null when unknown or turned off.",
  properties: {
    plan: { type: ["string", "null"] },
    windows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: 'e.g. "5-hour" or "weekly".' },
          used_percent: { type: "number" },
          resets_at: { type: ["string", "null"], description: "ISO 8601 time the window resets." },
        },
        required: ["label", "used_percent", "resets_at"],
      },
    },
    near_limit: { type: "boolean", description: "A window is past PIXMITH_USAGE_WARN_PERCENT." },
    credits_available: { type: "boolean" },
  },
  required: ["windows", "near_limit", "credits_available"],
};

const STATUSES = ["queued", "running", "done", "cancelled", "error"];

/** Output of generate_image, edit_image and get_image_result. */
export const JOB_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: STATUSES },
    job_id: { type: "string", description: "Absent only when the call failed before a job was created." },
    mode: { type: "string", enum: ["generate", "edit"] },
    stage: { type: "string", description: "What a queued or running job is doing." },
    queue_position: { type: "integer", description: "1-based position of a queued job." },
    elapsed_seconds: { type: "integer" },
    expected_seconds: { type: "integer", description: "Typical total time for this kind of job, from recent history." },
    path: { type: "string", description: "Absolute path of the saved PNG." },
    size: { type: "string", description: 'Actual "WIDTHxHEIGHT" of the PNG.' },
    width: { type: ["integer", "null"] },
    height: { type: ["integer", "null"] },
    requested_size: { type: "string" },
    size_note: { type: "string", description: "How the requested size was adjusted, if it was." },
    bytes: { type: "integer" },
    source_image: { type: "string", description: "The image an edit was made from." },
    codex_copy: { type: "string", description: "Codex's own copy of the PNG under CODEX_HOME." },
    metadata_path: { type: "string", description: "The JSON sidecar beside the PNG recording its prompt, sizes and sources." },
    inline_image: {
      type: ["object", "null"],
      description: "The image sent in `content`; null when none was sent.",
      properties: {
        mime_type: { type: "string" },
        width: { type: ["integer", "null"] },
        height: { type: ["integer", "null"] },
        preview: { type: "boolean", description: "True when it is a reduced JPEG preview, not the PNG itself." },
      },
      required: ["mime_type", "width", "height", "preview"],
    },
    usage: USAGE_SCHEMA,
    error: ERROR_SCHEMA,
  },
  required: ["status"],
};

/** Output of cancel_image. */
export const CANCEL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: STATUSES, description: "The job's status after this call." },
    job_id: { type: "string" },
    cancel_requested: {
      type: "boolean",
      description: 'True when this call cancelled the job. With status still "running", Codex is being stopped.',
    },
    previous_status: { type: "string", enum: ["queued", "running"] },
    elapsed_seconds: { type: "integer" },
    error: ERROR_SCHEMA,
  },
  required: ["status"],
};

/** Stages in which the image already exists and only bookkeeping remains. */
const FINAL_STAGES = new Set(["finishing", "saving"]);

const secs = (ms) => Math.max(0, Math.round(ms / 1000));

export function createTools({ jobs, config, readUsage = readCodexUsage }) {
  // Usage reporting is best-effort: a failure to read Codex's logs must never
  // fail a job or hide its result.
  const safeUsage = async (opts) => {
    if (config.showUsage === false) return null;
    try {
      return await readUsage(opts);
    } catch {
      return null;
    }
  };

  const structuredOn = config.structuredOutput !== false;
  const outputSchema = (schema) => (structuredOn ? { outputSchema: schema } : {});
  /** Attach structuredContent (dropping undefined fields) when it is turned on. */
  const withData = (result, data) => (structuredOn ? { ...result, structuredContent: compact(data) } : result);

  const waitSecs = secs(config.pollWaitMs);
  const typical = () => `~${secs(jobs.stats.estimate("generate"))}s`;

  const sizeProperty = (forEdit) => ({
    type: "string",
    description:
      'Optional. "auto", a shortcut "1K"/"2K"/"4K", or explicit "WIDTHxHEIGHT" (e.g. "1024x1024", "1536x1024", "1024x1536", "3840x2160"). ' +
      "Each edge must be a multiple of 16 (rounded for you), the longest edge at most 3840, the aspect ratio at most 3:1, " +
      "and the total pixel count between 655,360 and 8,294,400. " +
      (forEdit ? 'Defaults to "auto", which keeps the source image\'s aspect ratio.' : "Defaults to 1024x1024."),
  });
  const outputDirProperty = {
    type: "string",
    description:
      "Optional. Absolute directory to save the PNG into. Defaults to Pixmith's images/ folder " +
      "(override with the PIXMITH_OUTPUT_DIR env var).",
  };
  const waitProperty = {
    type: "boolean",
    description:
      `Optional, default true: wait up to ~${waitSecs}s and return the finished image directly when it is ready in time. ` +
      "Set false to return the job_id at once (useful for starting several jobs back to back).",
  };
  const creditsProperty = {
    type: "boolean",
    description:
      "Optional, default false. Only relevant once the ChatGPT plan's Codex limit is used up: Pixmith then refuses to start a job " +
      "and explains why. Set true ONLY after the user has explicitly agreed to continue on paid credits.",
  };
  const referenceProperty = {
    type: "array",
    items: { type: "string" },
    maxItems: MAX_INPUT_IMAGES,
    description:
      "Optional. Absolute paths of images (PNG, JPEG, WebP or GIF) to use as style, composition or subject references.",
  };

  const GENERATE_TOOL = {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using the OpenAI Codex CLI (gpt-image-2 via the $imagegen skill). " +
      "Runs on the user's signed-in ChatGPT subscription — no API key — and counts toward the ChatGPT plan's usage limits. " +
      `A generation typically takes ${typical()}. This call waits up to ~${waitSecs}s: if the image is ready in time it is returned ` +
      'directly (status "done", saved path plus the image inline). Otherwise it returns status "running" or "queued" with a job_id — ' +
      "then call `get_image_result` until it is done. To change a finished image, call `edit_image` with its path. " +
      "To stop a job, call `cancel_image`.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Required. Text description of the image to generate." },
        size: sizeProperty(false),
        reference_images: referenceProperty,
        output_dir: outputDirProperty,
        wait: waitProperty,
        use_credits: creditsProperty,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    ...outputSchema(JOB_OUTPUT_SCHEMA),
  };

  const EDIT_TOOL = {
    name: "edit_image",
    description:
      "Edit an existing image with a text instruction (gpt-image-2 via the Codex CLI, on the user's ChatGPT subscription). " +
      "Use it to refine a previous Pixmith result or to change any local image: replace a background, add or remove an object, " +
      "change lighting or style, fix text. The source file is never modified — the edit is saved as a new PNG. " +
      `Behaves like generate_image: waits up to ~${waitSecs}s and returns the image directly when ready, otherwise a job_id for \`get_image_result\`.`,
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Required. Absolute path of the image to edit (PNG, JPEG, WebP or GIF) — e.g. the Path returned by generate_image.",
        },
        prompt: {
          type: "string",
          description:
            'Required. What to change, e.g. "make the sky a stormy purple; keep everything else unchanged". Say what must stay the same.',
        },
        reference_images: referenceProperty,
        size: sizeProperty(true),
        output_dir: outputDirProperty,
        wait: waitProperty,
        use_credits: creditsProperty,
      },
      required: ["image", "prompt"],
      additionalProperties: false,
    },
    ...outputSchema(JOB_OUTPUT_SCHEMA),
  };

  const RESULT_TOOL = {
    name: "get_image_result",
    description:
      `Fetch the result of a generate_image / edit_image job. Waits up to ~${waitSecs}s for it to finish. ` +
      'If the returned status is "queued" or "running", call this again — repeat until status is "done". ' +
      "On success it returns the saved absolute PNG path and, when small enough, the image inline. " +
      "job_id is optional: without it the most recent job is used, so a result can still be recovered if an earlier call timed out. " +
      "Finished results stay available for 15 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional. The job_id to fetch. Defaults to the most recent job." },
      },
      additionalProperties: false,
    },
    ...outputSchema(JOB_OUTPUT_SCHEMA),
  };

  const CANCEL_TOOL = {
    name: "cancel_image",
    description:
      "Cancel a queued or running image job. A running job's Codex session is stopped immediately, so it stops consuming the " +
      "ChatGPT plan's quota. job_id is optional: without it the most recent unfinished job is cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional. The job to cancel. Defaults to the most recent unfinished job." },
      },
      additionalProperties: false,
    },
    ...outputSchema(CANCEL_OUTPUT_SCHEMA),
  };

  // ---- shared argument validation -------------------------------------------------

  function readCommon(args, { forEdit }) {
    const prompt = args.prompt;
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new PixmithError("bad_request", "`prompt` is required and must be a non-empty string.");
    }
    // Validate size and output_dir now so a bad request fails instantly instead
    // of after a full agent session.
    const requestedSize = forEdit && (args.size == null || String(args.size).trim() === "") ? "auto" : args.size;
    const sizeCheck = normalizeSize(requestedSize);
    if (sizeCheck.error) throw new PixmithError("bad_request", `Invalid \`size\`: ${sizeCheck.error}`);

    let outputDir;
    if (args.output_dir != null) {
      if (typeof args.output_dir !== "string" || !args.output_dir.trim()) {
        throw new PixmithError("bad_request", "`output_dir` must be a non-empty string when provided.");
      }
      outputDir = args.output_dir.trim();
      if (!path.isAbsolute(outputDir)) {
        throw new PixmithError("bad_request", `\`output_dir\` must be an absolute path (got "${args.output_dir}").`);
      }
    }
    if (args.wait != null && typeof args.wait !== "boolean") {
      throw new PixmithError("bad_request", "`wait` must be true or false.");
    }
    if (args.use_credits != null && typeof args.use_credits !== "boolean") {
      throw new PixmithError("bad_request", "`use_credits` must be true or false.");
    }
    return { prompt: prompt.trim(), size: requestedSize, sizeNote: sizeCheck.note, outputDir, wait: args.wait !== false };
  }

  async function start(args, request, extra, { forEdit }) {
    const common = readCommon(args, { forEdit });
    const paths = [];
    if (forEdit) {
      if (!args.image || typeof args.image !== "string" || !args.image.trim()) {
        throw new PixmithError("bad_request", "`image` is required: the absolute path of the image to edit.");
      }
      paths.push(args.image);
    }
    if (args.reference_images != null) {
      if (!Array.isArray(args.reference_images)) {
        throw new PixmithError("bad_request", "`reference_images` must be an array of absolute file paths.");
      }
      paths.push(...args.reference_images);
    }
    const images = await validateInputImages(paths);

    // Plan limit already used up? Then this job would run on paid credits (or
    // simply fail), so it only starts with the user's say-so.
    const gate = creditGate(await safeUsage(), { policy: config.creditsPolicy, useCredits: args.use_credits === true });
    if (gate.action !== "proceed") {
      throw new PixmithError(gate.action === "block" ? "usage_limit" : "credits_confirmation_needed", gate.message);
    }

    const job = jobs.create({
      prompt: common.prompt,
      size: common.size,
      outputDir: common.outputDir,
      images,
      mode: forEdit ? "edit" : "generate",
    });
    job.sizeNote = common.sizeNote;

    if (common.wait) await waitWithProgress(job, request, extra);
    return report(job, { justStarted: true });
  }

  // ---- waiting + progress -----------------------------------------------------------

  function stageText(job) {
    if (job.status === "queued") return `Queued (position ${jobs.queuePosition(job.id)})`;
    return STAGE_LABELS[job.stage] || "Working";
  }

  /** Long-poll a job for at most config.pollWaitMs, emitting progress notifications as it goes. */
  async function waitWithProgress(job, request, extra) {
    if (!jobs.isActive(job)) return;
    const progressToken = request?.params?._meta?.progressToken;
    const canNotify = progressToken !== undefined && typeof extra?.sendNotification === "function";

    let lastProgress = 0;
    let lastMessage = "";
    const tick = () => {
      if (!canNotify || !jobs.isActive(job)) return;
      const elapsed = secs(jobs.elapsedMs(job));
      const eta = secs(jobs.etaMs(job));
      const message =
        job.status === "queued"
          ? `${stageText(job)} — waiting ${elapsed}s for a free slot`
          : elapsed > eta
            ? `${stageText(job)} — ${elapsed}s, longer than the usual ~${eta}s`
            : `${stageText(job)} — ${elapsed}s of ~${eta}s`;
      // `progress` must rise on every notification; `total` is only an estimate,
      // so keep it ahead of `progress` when a job overruns.
      const progress = Math.max(lastProgress + 1, job.status === "queued" ? 0 : elapsed);
      if (message === lastMessage && progress === lastProgress) return;
      lastProgress = progress;
      lastMessage = message;
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, total: Math.max(eta, progress + 5), message },
        })
        .catch(() => {});
    };

    tick();
    const heartbeat = setInterval(tick, 3000);
    try {
      await jobs.wait(job, config.pollWaitMs, extra?.signal);
      // Codex has already finished and the image is only being collected: a
      // short grace here returns the image now instead of costing the client
      // another round trip for the sake of a second or two.
      if (jobs.isActive(job) && FINAL_STAGES.has(job.stage) && !extra?.signal?.aborted) {
        await jobs.wait(job, config.finishGraceMs ?? 0, extra?.signal);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ---- responses ----------------------------------------------------------------------

  async function report(job, { justStarted = false } = {}) {
    if (job.status === "done") return doneResult(job);

    if (job.status === "error") return withData(errorResult(formatError(job.error)), errorData(job.error, job));

    if (job.status === "cancelled") {
      return withData(text([`status: cancelled`, `job_id: ${job.id}`, "", "This job was cancelled. No image was produced."]), {
        status: "cancelled",
        job_id: job.id,
        mode: job.mode,
      });
    }

    const lines = [`status: ${job.status}`, `job_id: ${job.id}`, `stage: ${stageText(job)}`];
    const typicalSecs = secs(jobs.etaMs(job));
    const elapsed = secs(jobs.elapsedMs(job));
    const data = {
      status: job.status,
      job_id: job.id,
      mode: job.mode,
      stage: stageText(job),
      elapsed_seconds: elapsed,
      expected_seconds: typicalSecs,
    };
    if (job.status === "queued") {
      data.queue_position = jobs.queuePosition(job.id);
      lines.push(`queue_position: ${data.queue_position} (max ${jobs.maxConcurrent} at once; each takes ~${typicalSecs}s)`);
    } else {
      const outlook = elapsed > typicalSecs ? "taking longer than usual" : `about ${secs(jobs.remainingMs(job))}s left`;
      lines.push(`elapsed: ${elapsed}s (typical: ~${typicalSecs}s, ${outlook})`);
    }
    if (justStarted && job.sizeNote) {
      data.size_note = job.sizeNote;
      lines.push(`size_note: ${job.sizeNote}`);
    }
    lines.push(
      "",
      `${justStarted ? "The job is underway" : "Still working"}. Call get_image_result with this job_id to fetch the image ` +
        "(repeat while status is queued/running). Call cancel_image to stop it.",
    );
    return withData(text(lines), data);
  }

  async function doneResult(job) {
    const result = job.result;
    // Report the PNG's real dimensions; gpt-image-2 does not always return
    // exactly the requested size, and "auto" has no fixed size at all.
    const sizeParts = [];
    if (result.requestedSize && result.requestedSize !== result.size) sizeParts.push(`requested ${result.requestedSize}`);
    if (result.sizeNote) sizeParts.push(result.sizeNote);
    const verb = job.mode === "edit" ? "edited" : "generated";
    const lines = [
      `status: done`,
      `Image ${verb} in ${secs(jobs.elapsedMs(job))}s and saved.`,
      `Path: ${result.path}`,
      `Size: ${result.size}${sizeParts.length ? ` (${sizeParts.join("; ")})` : ""}`,
      `Bytes: ${result.bytes}`,
    ];
    if (job.mode === "edit" && result.inputImages?.length) lines.push(`Edited from: ${result.inputImages[0]}`);
    if (result.codexHomeCopy && result.codexHomeCopy !== result.path) lines.push(`Codex copy: ${result.codexHomeCopy}`);
    if (result.metadataPath) lines.push(`Metadata: ${result.metadataPath}`);
    // Read once per job: the figure describes the moment the job finished, and a
    // result can be fetched several times.
    if (!job.usageReport) {
      const usage = await safeUsage({ sessionId: result.sessionId });
      const opts = { warnPercent: config.usageWarnPercent };
      job.usageReport = { lines: usageLines(usage, opts), summary: usageSummary(usage, opts) };
    }
    lines.push(...job.usageReport.lines);
    if (config.codexBinNote) lines.push(`Note: ${config.codexBinNote}`);
    lines.push(`job_id: ${job.id}`, "", `To change this image, call edit_image with image="${result.path}" and describe the change.`);

    // Inline image. MCP clients cap the size of a tool result (Claude Desktop:
    // 1 MB), so a PNG over the budget travels as a JPEG preview while the
    // full-quality PNG stays at the path above. Built once per job.
    if (config.returnImage && job.inline === undefined) {
      try {
        const inline = await makeInlineImage(result.path, config.maxInlineBytes);
        job.inline = inline
          ? {
              item: { type: "image", data: inline.data.toString("base64"), mimeType: inline.mimeType },
              meta: {
                mime_type: inline.mimeType,
                width: inline.width ?? result.width ?? null,
                height: inline.height ?? result.height ?? null,
                preview: inline.preview,
              },
              note: inline.preview
                ? `Inline preview: ${inline.width}x${inline.height} JPEG, sized to fit the client's tool-result limit. The full-quality PNG is at the path above.`
                : null,
            }
          : { item: null, note: `(Image not inlined: no preview fits within PIXMITH_MAX_INLINE_BYTES=${config.maxInlineBytes}. Open it from the path above.)` };
      } catch (err) {
        job.inline = { item: null, note: `(Could not inline image: ${err.message}. Open it from the path above.)` };
      }
    }
    if (job.inline?.note) lines.splice(lines.indexOf(""), 0, job.inline.note);

    const content = [{ type: "text", text: lines.join("\n") }];
    if (job.inline?.item) content.push(job.inline.item);
    return withData(
      { content },
      {
        status: "done",
        job_id: job.id,
        mode: job.mode,
        path: result.path,
        size: result.size,
        width: result.width ?? null,
        height: result.height ?? null,
        requested_size: result.requestedSize,
        size_note: result.sizeNote || undefined,
        bytes: result.bytes,
        elapsed_seconds: secs(jobs.elapsedMs(job)),
        source_image: job.mode === "edit" ? result.inputImages?.[0] : undefined,
        codex_copy: result.codexHomeCopy && result.codexHomeCopy !== result.path ? result.codexHomeCopy : undefined,
        metadata_path: result.metadataPath ?? undefined,
        inline_image: job.inline?.item ? job.inline.meta : null,
        usage: job.usageReport.summary,
      },
    );
  }

  // ---- get_image_result / cancel_image --------------------------------------------------

  function resolveJob(args, { activeOnly = false } = {}) {
    const jobId = args.job_id;
    if (jobId != null && (typeof jobId !== "string" || !jobId.trim())) {
      throw new PixmithError("bad_request", "`job_id` must be a non-empty string when provided.");
    }
    if (jobId) {
      const job = jobs.get(jobId.trim());
      if (!job) {
        throw new PixmithError(
          "unknown_job",
          `No job found for job_id "${jobId}". It may have expired (results are kept for 15 minutes) — start a new one with generate_image.`,
        );
      }
      return job;
    }
    const job = jobs.latest({ activeOnly });
    if (!job) {
      throw new PixmithError(
        "unknown_job",
        activeOnly ? "There is no queued or running job to cancel." : "No jobs yet — call generate_image or edit_image first.",
      );
    }
    return job;
  }

  async function getResult(args, request, extra) {
    const job = resolveJob(args);
    await waitWithProgress(job, request, extra);
    return report(job);
  }

  async function cancel(args) {
    const job = resolveJob(args, { activeOnly: args.job_id == null });
    const was = await jobs.cancel(job);
    if (was === null) {
      const note =
        job.status === "done"
          ? "Nothing to cancel: this job had already finished. Call get_image_result to fetch its image."
          : "Nothing to cancel: this job is no longer running.";
      return withData(text([`status: ${job.status}`, `job_id: ${job.id}`, "", note]), {
        status: job.status,
        job_id: job.id,
        cancel_requested: false,
      });
    }
    if (jobs.isActive(job)) {
      const note = "Cancellation was requested and the Codex session is being stopped; it has not exited yet.";
      return withData(text([`status: ${job.status}`, `job_id: ${job.id}`, "", note]), {
        status: job.status,
        job_id: job.id,
        cancel_requested: true,
        previous_status: was,
      });
    }
    const elapsed = secs(jobs.elapsedMs(job));
    const note =
      was === "queued"
        ? "The job was removed from the queue before it started."
        : `The running job was stopped after ${elapsed}s. No image was produced.`;
    return withData(text(["status: cancelled", `job_id: ${job.id}`, "", note]), {
      status: "cancelled",
      job_id: job.id,
      cancel_requested: true,
      previous_status: was,
      elapsed_seconds: was === "running" ? elapsed : undefined,
    });
  }

  async function call(name, args = {}, request, extra) {
    try {
      if (name === GENERATE_TOOL.name) return await start(args, request, extra, { forEdit: false });
      if (name === EDIT_TOOL.name) return await start(args, request, extra, { forEdit: true });
      if (name === RESULT_TOOL.name) return await getResult(args, request, extra);
      if (name === CANCEL_TOOL.name) return await cancel(args);
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return withData(errorResult(formatError(err)), errorData(err));
    }
  }

  return { tools: [GENERATE_TOOL, EDIT_TOOL, RESULT_TOOL, CANCEL_TOOL], call };
}

function text(lines) {
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** What the user can do about each kind of failure — appended to the error text. */
const NEXT_STEPS = {
  binary_missing: "Install the Codex CLI or the Codex desktop app, or set CODEX_BIN, then retry.",
  not_signed_in: "Run `codex login` (or sign in from the Codex app), then retry.",
  usage_limit:
    "Nothing is wrong with the request. Retry once the ChatGPT plan's limit has reset, or add credits in ChatGPT under Settings > Usage.",
  credits_confirmation_needed: "Ask the user; do not retry with use_credits: true unless they agree.",
  timeout: "Retry, use a smaller size, or raise PIXMITH_TIMEOUT_MS.",
  generation_failed: "If the request was refused, rephrase the prompt; otherwise retry.",
  no_output: "Retry once. If it keeps failing, run `codex exec \"hello\"` to check that Codex itself works.",
};

export function formatError(err) {
  if (err instanceof PixmithError) {
    const next = NEXT_STEPS[err.kind] ? `\n\nNext step: ${NEXT_STEPS[err.kind]}` : "";
    const detail = err.detail ? `\n\nDetail:\n${err.detail}` : "";
    return `[${err.kind}] ${err.message}${next}${detail}`;
  }
  return `Unexpected error: ${err?.message || String(err)}`;
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** structuredContent for a failure, with the job it belongs to when there is one. */
function errorData(err, job = null) {
  const kind = err instanceof PixmithError ? err.kind : "unexpected";
  return {
    status: "error",
    job_id: job?.id,
    mode: job?.mode,
    error: { kind, message: err?.message || String(err), next_step: NEXT_STEPS[kind] },
  };
}

/** A copy of `obj` without undefined fields, recursively, so it validates against the schemas. */
function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact);
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, compact(v)]));
}
