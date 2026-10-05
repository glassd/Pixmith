import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeSize } from "./config.js";
import { BACKGROUNDS, PixmithError, STAGE_LABELS, cleanFilename, validateInputImages, MAX_INPUT_IMAGES } from "./codex.js";
import { jobFromEntry } from "./history.js";
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
//   list_images                  lists earlier images from the history, newest
//                                first (a finished job_id also stays collectable
//                                through it after a restart).
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

/** The most variants one call may ask for. Each is a full generation. */
export const MAX_VARIANTS = 4;

/** Fields describing one job, shared by single results and each entry of `variants`. */
const JOB_PROPERTIES = {
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
  background: { type: "string", enum: BACKGROUNDS, description: "The background that was asked for." },
  has_alpha: {
    type: ["boolean", "null"],
    description: "Whether the PNG has an alpha channel (can be transparent); null when unknown.",
  },
  usage: USAGE_SCHEMA,
  error: ERROR_SCHEMA,
};

/** Output of generate_image, edit_image and get_image_result. */
export const JOB_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ...JOB_PROPERTIES,
    job_ids: {
      type: "array",
      items: { type: "string" },
      description: "With variants > 1: every variant's job_id, in order. Each is collected with get_image_result on its own.",
    },
    variants: {
      type: "array",
      items: { type: "object", properties: JOB_PROPERTIES, required: ["status"] },
      description: "With variants > 1: each variant's result, in order. The top-level status then summarises them.",
    },
  },
  required: ["status"],
};

/** One image in list_images' output. */
const LISTED_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of the PNG." },
    job_id: { type: "string" },
    created_at: { type: "string", description: "ISO 8601 time the image was finished." },
    mode: { type: "string", enum: ["generate", "edit"] },
    prompt: { type: "string", description: "The image prompt, or an edit's instruction." },
    size: { type: "string" },
    width: { type: ["integer", "null"] },
    height: { type: ["integer", "null"] },
    source_image: { type: "string", description: "The image an edit was made from." },
    metadata_path: { type: "string" },
  },
  required: ["path", "job_id", "created_at", "mode", "prompt"],
};

/** Output of list_images. */
export const LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "error"] },
    images: { type: "array", items: LISTED_IMAGE_SCHEMA, description: "Newest first." },
    total: { type: "integer", description: "How many images match, of which `images` is the newest `limit`." },
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

export function createTools({ jobs, config, readUsage = readCodexUsage, history = null }) {
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
  const backgroundProperty = {
    type: "string",
    enum: BACKGROUNDS,
    description:
      'Optional, default "auto" (transparent only when the prompt asks for it). "transparent" asks for a PNG with an alpha ' +
      "channel, the subject alone with no backdrop (for a logo, icon or sticker); the model does not always manage it, and the " +
      'result says whether the PNG really has one. "opaque" rules transparency out.',
  };
  const filenameProperty = {
    type: "string",
    description:
      'Optional. File name for the PNG, without a folder (e.g. "hero-banner"); default: made from the prompt. Cleaned to ' +
      'letters, digits, ".", "_" and "-". An existing file is never overwritten: "-2", "-3"... is added instead.',
  };
  const variantsProperty = {
    type: "integer",
    minimum: 1,
    maximum: MAX_VARIANTS,
    description:
      `Optional, default 1. How many alternative images to make (1-${MAX_VARIANTS}). Each is a separate generation that ` +
      "counts toward the ChatGPT plan's usage, and they run one after another unless PIXMITH_MAX_CONCURRENT is raised, so " +
      "only ask for more than one when the user wants options to choose from. Each variant gets its own job_id.",
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
        background: backgroundProperty,
        variants: variantsProperty,
        filename: filenameProperty,
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
        background: backgroundProperty,
        variants: variantsProperty,
        filename: filenameProperty,
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
      "A finished image's job_id keeps working later, even after a restart.",
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

  const LIST_TOOL = {
    name: "list_images",
    description:
      "List images Pixmith made earlier, newest first, with each one's path, prompt, size and job_id — to find an earlier " +
      "image again, e.g. to show it or to edit it with edit_image. Covers every output folder. Images deleted since are left out.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Optional. How many to return, 1-50. Default 10." },
        query: { type: "string", description: "Optional. Only images whose prompt contains this text (case-insensitive)." },
        mode: { type: "string", enum: ["generate", "edit"], description: "Optional. Only generated, or only edited, images." },
      },
      additionalProperties: false,
    },
    ...outputSchema(LIST_OUTPUT_SCHEMA),
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
    const background = args.background ?? "auto";
    if (!BACKGROUNDS.includes(background)) {
      throw new PixmithError("bad_request", `\`background\` must be one of ${BACKGROUNDS.join(", ")}.`);
    }
    const variants = args.variants ?? 1;
    if (!Number.isInteger(variants) || variants < 1 || variants > MAX_VARIANTS) {
      throw new PixmithError("bad_request", `\`variants\` must be a whole number from 1 to ${MAX_VARIANTS}.`);
    }
    return {
      prompt: prompt.trim(),
      size: requestedSize,
      sizeNote: sizeCheck.note,
      outputDir,
      background,
      variants,
      filename: cleanFilename(args.filename),
      wait: args.wait !== false,
    };
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

    // Variants are independent jobs; with a chosen filename they are numbered.
    const list = [];
    for (let i = 1; i <= common.variants; i += 1) {
      const job = jobs.create({
        prompt: common.prompt,
        size: common.size,
        outputDir: common.outputDir,
        images,
        mode: forEdit ? "edit" : "generate",
        background: common.background,
        filename: common.filename && common.variants > 1 ? `${common.filename}-${i}` : common.filename,
      });
      job.sizeNote = common.sizeNote;
      list.push(job);
    }

    if (common.wait) await waitWithProgress(list, request, extra);
    return list.length === 1 ? report(list[0], { justStarted: true }) : batchReport(list, { justStarted: true });
  }

  // ---- waiting + progress -----------------------------------------------------------

  function stageText(job) {
    if (job.status === "queued") return `Queued (position ${jobs.queuePosition(job.id)})`;
    return STAGE_LABELS[job.stage] || "Working";
  }

  /**
   * Long-poll one job, or several sharing one window, for at most
   * config.pollWaitMs in total, emitting progress notifications as they go.
   */
  async function waitWithProgress(jobOrList, request, extra) {
    const list = [].concat(jobOrList);
    if (!list.some((j) => jobs.isActive(j))) return;
    const progressToken = request?.params?._meta?.progressToken;
    const canNotify = progressToken !== undefined && typeof extra?.sendNotification === "function";

    let lastProgress = 0;
    let lastMessage = "";
    const tick = () => {
      const active = list.filter((j) => jobs.isActive(j));
      if (!canNotify || !active.length) return;
      const job = active[0];
      const elapsed = secs(jobs.elapsedMs(job));
      const eta = secs(jobs.etaMs(job));
      let message =
        job.status === "queued"
          ? `${stageText(job)} — waiting ${elapsed}s for a free slot`
          : elapsed > eta
            ? `${stageText(job)} — ${elapsed}s, longer than the usual ~${eta}s`
            : `${stageText(job)} — ${elapsed}s of ~${eta}s`;
      if (list.length > 1) {
        message = `${list.length - active.length} of ${list.length} variants done. Variant ${list.indexOf(job) + 1}: ${message}`;
      }
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
      const deadline = Date.now() + config.pollWaitMs;
      for (const job of list) {
        if (extra?.signal?.aborted) break;
        await jobs.wait(job, deadline - Date.now(), extra?.signal);
      }
      // Codex has already finished and the image is only being collected: a
      // short grace here returns the image now instead of costing the client
      // another round trip for the sake of a second or two.
      const graceEnd = Date.now() + (config.finishGraceMs ?? 0);
      for (const job of list) {
        if (!jobs.isActive(job) || !FINAL_STAGES.has(job.stage) || extra?.signal?.aborted) continue;
        await jobs.wait(job, graceEnd - Date.now(), extra?.signal);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ---- responses ----------------------------------------------------------------------

  /**
   * One job's share of a result. `head` and `tail` are text lines around where
   * the usage lines go, `footer` is the closing instruction, `image` the inline
   * content item, `data` its structuredContent, and `usage` (finished jobs) the
   * plan-usage report. A failed job carries `errorText` instead.
   */
  async function jobParts(job, { justStarted = false, inlineBudget = config.maxInlineBytes } = {}) {
    const base = { tail: [], footer: null, image: null, usage: null };
    if (job.status === "done") return doneParts(job, inlineBudget);

    if (job.status === "error") {
      return { ...base, status: "error", head: [`status: error`, `job_id: ${job.id}`], errorText: formatError(job.error), data: errorData(job.error, job) };
    }

    if (job.status === "cancelled") {
      return {
        ...base,
        status: "cancelled",
        head: [`status: cancelled`, `job_id: ${job.id}`],
        footer: "This job was cancelled. No image was produced.",
        data: { status: "cancelled", job_id: job.id, mode: job.mode },
      };
    }

    const head = [`status: ${job.status}`, `job_id: ${job.id}`, `stage: ${stageText(job)}`];
    const typicalSecs = secs(jobs.etaMs(job));
    const elapsed = secs(jobs.elapsedMs(job));
    const data = {
      status: job.status,
      job_id: job.id,
      mode: job.mode,
      stage: stageText(job),
      elapsed_seconds: elapsed,
      expected_seconds: typicalSecs,
      background: job.background,
    };
    if (job.status === "queued") {
      data.queue_position = jobs.queuePosition(job.id);
      head.push(`queue_position: ${data.queue_position} (max ${jobs.maxConcurrent} at once; each takes ~${typicalSecs}s)`);
    } else {
      const outlook = elapsed > typicalSecs ? "taking longer than usual" : `about ${secs(jobs.remainingMs(job))}s left`;
      head.push(`elapsed: ${elapsed}s (typical: ~${typicalSecs}s, ${outlook})`);
    }
    if (justStarted && job.sizeNote) {
      data.size_note = job.sizeNote;
      head.push(`size_note: ${job.sizeNote}`);
    }
    const footer =
      `${justStarted ? "The job is underway" : "Still working"}. Call get_image_result with this job_id to fetch the image ` +
      "(repeat while status is queued/running). Call cancel_image to stop it.";
    return { ...base, status: job.status, head, footer, data };
  }

  /** What the result says about the background, if anything worth saying. */
  function backgroundLine(result) {
    if (result.background === "transparent") {
      if (result.hasAlpha === true) return "Background: transparent (the PNG has an alpha channel).";
      if (result.hasAlpha === false) {
        return "Background: transparency was asked for, but the PNG has no alpha channel, so its background is opaque. Retry, or remove the background with another tool.";
      }
      return null;
    }
    return result.hasAlpha === true ? "Background: the PNG has an alpha channel (it can be transparent)." : null;
  }

  async function doneParts(job, inlineBudget) {
    const result = job.result;
    // Report the PNG's real dimensions; gpt-image-2 does not always return
    // exactly the requested size, and "auto" has no fixed size at all.
    const sizeParts = [];
    if (result.requestedSize && result.requestedSize !== result.size) sizeParts.push(`requested ${result.requestedSize}`);
    if (result.sizeNote) sizeParts.push(result.sizeNote);
    const verb = job.mode === "edit" ? "edited" : "generated";
    const head = [
      `status: done`,
      `Image ${verb} in ${secs(jobs.elapsedMs(job))}s and saved.`,
      `Path: ${result.path}`,
      `Size: ${result.size}${sizeParts.length ? ` (${sizeParts.join("; ")})` : ""}`,
      `Bytes: ${result.bytes}`,
    ];
    const bg = backgroundLine(result);
    if (bg) head.push(bg);
    if (job.mode === "edit" && result.inputImages?.length) head.push(`Edited from: ${result.inputImages[0]}`);
    if (result.codexHomeCopy && result.codexHomeCopy !== result.path) head.push(`Codex copy: ${result.codexHomeCopy}`);
    if (result.metadataPath) head.push(`Metadata: ${result.metadataPath}`);
    // Read once per job: the figure describes the moment the job finished, and a
    // result can be fetched several times. A job restored from the history
    // describes the past, where today's usage would mislead.
    if (job.restored) job.usageReport ??= { lines: [], summary: null };
    if (!job.usageReport) {
      const usage = await safeUsage({ sessionId: result.sessionId });
      const opts = { warnPercent: config.usageWarnPercent };
      job.usageReport = { lines: usageLines(usage, opts), summary: usageSummary(usage, opts) };
    }
    const tail = [];
    if (config.codexBinNote) tail.push(`Note: ${config.codexBinNote}`);
    tail.push(`job_id: ${job.id}`);

    // Inline image. MCP clients cap the size of a tool result (Claude Desktop:
    // 1 MB), so a PNG over the budget travels as a JPEG preview while the
    // full-quality PNG stays at the path above. Built once per job and budget
    // (variants share one result, so each gets a slice of the budget).
    if (config.returnImage && job.inlineBudget !== inlineBudget) {
      job.inlineBudget = inlineBudget;
      try {
        const inline = await makeInlineImage(result.path, inlineBudget);
        const flattened = inline?.preview && result.hasAlpha ? " Transparent areas show as white in it." : "";
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
                ? `Inline preview: ${inline.width}x${inline.height} JPEG, sized to fit the client's tool-result limit.${flattened} The full-quality PNG is at the path above.`
                : null,
            }
          : { item: null, note: `(Image not inlined: no preview fits within PIXMITH_MAX_INLINE_BYTES=${config.maxInlineBytes}. Open it from the path above.)` };
      } catch (err) {
        job.inline = { item: null, note: `(Could not inline image: ${err.message}. Open it from the path above.)` };
      }
    }
    if (job.inline?.note) tail.push(job.inline.note);

    return {
      status: "done",
      head,
      tail,
      footer: `To change this image, call edit_image with image="${result.path}" and describe the change.`,
      image: job.inline?.item ?? null,
      usage: job.usageReport,
      data: {
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
        background: result.background,
        has_alpha: result.hasAlpha,
        source_image: job.mode === "edit" ? result.inputImages?.[0] : undefined,
        codex_copy: result.codexHomeCopy && result.codexHomeCopy !== result.path ? result.codexHomeCopy : undefined,
        metadata_path: result.metadataPath ?? undefined,
        inline_image: job.inline?.item ? job.inline.meta : null,
        usage: job.usageReport.summary,
      },
    };
  }

  /** The result for a single job. */
  async function report(job, { justStarted = false } = {}) {
    const p = await jobParts(job, { justStarted });
    if (p.errorText) return withData(errorResult(p.errorText), p.data);
    const lines = [...p.head, ...(p.usage?.lines ?? []), ...p.tail, "", p.footer];
    const content = [{ type: "text", text: lines.join("\n") }];
    if (p.image) content.push(p.image);
    return withData({ content }, p.data);
  }

  /** The result for several variants started by one call. */
  async function batchReport(list, { justStarted = false } = {}) {
    const done = list.filter((j) => j.status === "done").length;
    // The variants share the client's tool-result limit.
    const inlineBudget = Math.floor(config.maxInlineBytes / Math.max(1, done));
    const parts = [];
    for (const job of list) parts.push(await jobParts(job, { justStarted, inlineBudget }));

    const count = (status) => parts.filter((p) => p.status === status).length;
    const active = count("queued") + count("running");
    const status = active
      ? count("running")
        ? "running"
        : "queued"
      : done
        ? "done"
        : count("cancelled") === parts.length
          ? "cancelled"
          : "error";
    const summary = [
      `${done} of ${list.length} done`,
      active && `${active} still working`,
      count("error") && `${count("error")} failed`,
      count("cancelled") && `${count("cancelled")} cancelled`,
    ].filter(Boolean);

    const lines = [`status: ${status}`, `Variants: ${summary.join(", ")}.`];
    parts.forEach((p, i) => {
      lines.push("", `Variant ${i + 1} of ${list.length}:`, ...p.head);
      if (p.errorText) lines.push(p.errorText);
      lines.push(...p.tail);
    });
    // One plan-usage report covers them all: the latest finished variant's.
    const usage = [...parts].reverse().find((p) => p.usage)?.usage ?? null;
    if (usage?.lines.length) lines.push("", ...usage.lines);
    const footers = [];
    if (active) {
      footers.push(
        "Call get_image_result with a variant's job_id to fetch it (repeat while it is queued/running). Call cancel_image to stop one.",
      );
    }
    if (done) footers.push("To change a variant, call edit_image with its Path and describe the change.");
    if (footers.length) lines.push("", ...footers);

    const content = [{ type: "text", text: lines.join("\n") }, ...parts.map((p) => p.image).filter(Boolean)];
    const data = {
      status,
      mode: list[0].mode,
      job_ids: list.map((j) => j.id),
      variants: parts.map((p) => p.data),
      usage: usage?.summary,
    };
    return withData(status === "error" ? { content, isError: true } : { content }, data);
  }

  // ---- get_image_result / cancel_image --------------------------------------------------

  async function resolveJob(args, { activeOnly = false } = {}) {
    const jobId = args.job_id;
    if (jobId != null && (typeof jobId !== "string" || !jobId.trim())) {
      throw new PixmithError("bad_request", "`job_id` must be a non-empty string when provided.");
    }
    if (jobId) {
      const id = jobId.trim();
      let job = jobs.get(id);
      // A finished image outlives its in-memory job (kept 15 minutes, and lost
      // on a restart) through the history.
      if (!job && history) {
        const entry = await history.find(id);
        if (entry) job = jobFromEntry(entry);
      }
      if (!job) {
        throw new PixmithError(
          "unknown_job",
          `No job found for job_id "${jobId}". Call list_images to find earlier images, or start a new one with generate_image.`,
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
    const job = await resolveJob(args);
    await waitWithProgress(job, request, extra);
    return report(job);
  }

  async function cancel(args) {
    const job = await resolveJob(args, { activeOnly: args.job_id == null });
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

  async function listImages(args) {
    const { limit = 10, query, mode } = args;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new PixmithError("bad_request", "`limit` must be a whole number from 1 to 50.");
    }
    if (query != null && typeof query !== "string") throw new PixmithError("bad_request", "`query` must be a string.");
    if (mode != null && mode !== "generate" && mode !== "edit") {
      throw new PixmithError("bad_request", '`mode` must be "generate" or "edit".');
    }
    const { images, total } = history ? await history.list({ limit, query: query?.trim() || null, mode }) : { images: [], total: 0 };

    const listed = images.map((e) => ({
      path: e.path,
      job_id: e.job_id,
      created_at: e.created_at,
      mode: e.mode,
      prompt: e.prompt,
      size: e.size,
      width: e.width,
      height: e.height,
      source_image: e.mode === "edit" ? e.input_images?.[0] : undefined,
      metadata_path: e.metadata_path ?? undefined,
    }));
    const filters = [query?.trim() && `matching "${query.trim()}"`, mode && `${mode === "edit" ? "edited" : "generated"} only`].filter(Boolean);
    const lines = [
      total === 0
        ? `No images found${filters.length ? ` (${filters.join(", ")})` : ""}.`
        : `${total} image${total === 1 ? "" : "s"}${filters.length ? ` (${filters.join(", ")})` : ""}` +
          (total > listed.length ? `, showing the newest ${listed.length}` : "") +
          ":",
    ];
    listed.forEach((img, i) => {
      const prompt = img.prompt.length > 200 ? `${img.prompt.slice(0, 200)}…` : img.prompt;
      lines.push(
        "",
        `${i + 1}. ${img.created_at.slice(0, 16).replace("T", " ")} UTC · ${img.mode === "edit" ? "edited" : "generated"} · ${img.size}`,
        `   Prompt: ${prompt}`,
        `   Path: ${img.path}`,
      );
      if (img.source_image) lines.push(`   Edited from: ${img.source_image}`);
      lines.push(`   job_id: ${img.job_id}`);
    });
    if (listed.length) {
      lines.push("", "To change one, call edit_image with its Path. get_image_result with its job_id returns it again, with the image.");
    }
    return withData(text(lines), { status: "ok", images: listed, total });
  }

  async function call(name, args = {}, request, extra) {
    try {
      if (name === GENERATE_TOOL.name) return await start(args, request, extra, { forEdit: false });
      if (name === EDIT_TOOL.name) return await start(args, request, extra, { forEdit: true });
      if (name === RESULT_TOOL.name) return await getResult(args, request, extra);
      if (name === CANCEL_TOOL.name) return await cancel(args);
      if (name === LIST_TOOL.name) return await listImages(args);
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return withData(errorResult(formatError(err)), errorData(err));
    }
  }

  return { tools: [GENERATE_TOOL, EDIT_TOOL, RESULT_TOOL, CANCEL_TOOL, LIST_TOOL], call };
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
