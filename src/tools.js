import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeSize } from "./config.js";
import { PixmithError, STAGE_LABELS, validateInputImages, MAX_INPUT_IMAGES } from "./codex.js";

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

const MIME = { png: "image/png" };

/** Stages in which the image already exists and only bookkeeping remains. */
const FINAL_STAGES = new Set(["finishing", "saving"]);

const secs = (ms) => Math.max(0, Math.round(ms / 1000));

export function createTools({ jobs, config }) {
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
      },
      required: ["prompt"],
      additionalProperties: false,
    },
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
      },
      required: ["image", "prompt"],
      additionalProperties: false,
    },
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

    if (job.status === "error") return errorResult(formatError(job.error));

    if (job.status === "cancelled") {
      return text([`status: cancelled`, `job_id: ${job.id}`, "", "This job was cancelled. No image was produced."]);
    }

    const lines = [`status: ${job.status}`, `job_id: ${job.id}`, `stage: ${stageText(job)}`];
    const typicalSecs = secs(jobs.etaMs(job));
    if (job.status === "queued") {
      lines.push(`queue_position: ${jobs.queuePosition(job.id)} (max ${jobs.maxConcurrent} at once; each takes ~${typicalSecs}s)`);
    } else {
      const elapsed = secs(jobs.elapsedMs(job));
      const outlook = elapsed > typicalSecs ? "taking longer than usual" : `about ${secs(jobs.remainingMs(job))}s left`;
      lines.push(`elapsed: ${elapsed}s (typical: ~${typicalSecs}s, ${outlook})`);
    }
    if (justStarted && job.sizeNote) lines.push(`size_note: ${job.sizeNote}`);
    lines.push(
      "",
      `${justStarted ? "The job is underway" : "Still working"}. Call get_image_result with this job_id to fetch the image ` +
        "(repeat while status is queued/running). Call cancel_image to stop it.",
    );
    return text(lines);
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
    if (config.codexBinNote) lines.push(`Note: ${config.codexBinNote}`);
    lines.push(`job_id: ${job.id}`, "", `To change this image, call edit_image with image="${result.path}" and describe the change.`);

    const content = [{ type: "text", text: lines.join("\n") }];
    if (config.returnImage) {
      if (result.bytes <= config.maxInlineBytes) {
        try {
          const data = await fs.readFile(result.path);
          content.push({ type: "image", data: data.toString("base64"), mimeType: MIME.png });
        } catch (err) {
          content.push({ type: "text", text: `(Could not inline image: ${err.message})` });
        }
      } else {
        content.push({
          type: "text",
          text: `(Image not inlined: ${result.bytes} bytes exceeds PIXMITH_MAX_INLINE_BYTES=${config.maxInlineBytes}. Open it from the path above.)`,
        });
      }
    }
    return { content };
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
      return text([
        `status: ${job.status}`,
        `job_id: ${job.id}`,
        "",
        job.status === "done"
          ? "Nothing to cancel: this job had already finished. Call get_image_result to fetch its image."
          : "Nothing to cancel: this job is no longer running.",
      ]);
    }
    if (jobs.isActive(job)) {
      return text([
        `status: ${job.status}`,
        `job_id: ${job.id}`,
        "",
        "Cancellation was requested and the Codex session is being stopped; it has not exited yet.",
      ]);
    }
    return text([
      "status: cancelled",
      `job_id: ${job.id}`,
      "",
      was === "queued"
        ? "The job was removed from the queue before it started."
        : `The running job was stopped after ${secs(jobs.elapsedMs(job))}s. No image was produced.`,
    ]);
  }

  async function call(name, args = {}, request, extra) {
    try {
      if (name === GENERATE_TOOL.name) return await start(args, request, extra, { forEdit: false });
      if (name === EDIT_TOOL.name) return await start(args, request, extra, { forEdit: true });
      if (name === RESULT_TOOL.name) return await getResult(args, request, extra);
      if (name === CANCEL_TOOL.name) return await cancel(args);
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return errorResult(formatError(err));
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
  usage_limit: "Nothing is wrong with the request. Retry once the ChatGPT plan's limit has reset.",
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
