#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config, normalizeSize } from "./config.js";
import { generateImage, PixmithError } from "./codex.js";

// Image generation takes ~50–90s — longer than the per-request timeout many MCP
// clients (e.g. Claude Desktop) enforce, and some clients do NOT extend that
// timeout on progress notifications. So Pixmith never blocks on the long call:
// `generate_image` queues a background job and returns instantly with a job_id,
// and `get_image_result` retrieves it, waiting at most config.pollWaitMs per
// call. No single tool call runs long enough to trip a client-side timeout.

const POLL_WAIT_MS = config.pollWaitMs;
const POLL_WAIT_SECS = Math.round(POLL_WAIT_MS / 1000);
const JOB_TTL_MS = 15 * 60 * 1000; // forget finished jobs after this long

const GENERATE_TOOL = {
  name: "generate_image",
  description:
    "Start generating an image from a text prompt using the OpenAI Codex CLI (gpt-image-2 via the $imagegen skill). " +
    "Runs on the user's signed-in ChatGPT subscription — no API key — and counts toward the ChatGPT plan's usage limits. " +
    "Generation takes ~50–90s, so this tool returns IMMEDIATELY with a job_id instead of blocking. " +
    "IMPORTANT: it does NOT return the image. After calling this, call `get_image_result` with the returned job_id to fetch the finished PNG.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Required. Text description of the image to generate.",
      },
      size: {
        type: "string",
        description:
          'Optional. "auto", a shortcut "1K"/"2K"/"4K", or explicit "WIDTHxHEIGHT" (e.g. "1024x1024", "1536x1024", "1024x1536", "3840x2160"). ' +
          "Each edge must be a multiple of 16 (rounded for you), the longest edge at most 3840, the aspect ratio at most 3:1, " +
          "and the total pixel count between 655,360 and 8,294,400. Defaults to 1024x1024.",
      },
      output_dir: {
        type: "string",
        description:
          "Optional. Absolute directory to save the PNG into. Defaults to Pixmith's images/ folder " +
          "(override with the PIXMITH_OUTPUT_DIR env var).",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const RESULT_TOOL = {
  name: "get_image_result",
  description:
    `Retrieve the result of a \`generate_image\` job by its job_id. Waits up to ~${POLL_WAIT_SECS} seconds for the image to finish, ` +
    'then returns. If the returned status is "queued" or "running", call this again with the SAME job_id — repeat until status is ' +
    '"done" (typically 2–4 calls for one image). On success it returns the saved absolute PNG path and, when small enough, ' +
    "the image inline. Each call is short and will not trip a client timeout.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Required. The job_id returned by generate_image.",
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};

const server = new Server(
  { name: "pixmith", version: config.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GENERATE_TOOL, RESULT_TOOL],
}));

// ---------------------------------------------------------------------------
// Job queue. At most config.maxConcurrent generations run at once; the rest
// wait in FIFO order with status "queued". Each generation is a full Codex
// agent session against the user's ChatGPT quota, so the default is 1.
// ---------------------------------------------------------------------------

/** jobId -> { status, queuedAt, startedAt, finishedAt, result, error, settled, resolveSettled, prompt, size, outputDir } */
const jobs = new Map();
/** jobIds waiting for a slot, in arrival order. */
const queue = [];
let running = 0;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function queuePosition(jobId) {
  const i = queue.indexOf(jobId);
  return i === -1 ? 0 : i + 1;
}

/** Start queued jobs while there is capacity. */
function pump() {
  while (running < config.maxConcurrent && queue.length) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job) continue;

    running += 1;
    job.status = "running";
    job.startedAt = Date.now();

    generateImage({
      prompt: job.prompt,
      size: job.size,
      outputDir: job.outputDir,
      onProgress: (line) => process.stderr.write(`[codex ${jobId.slice(0, 8)}] ${line}\n`),
    })
      .then((result) => {
        job.status = "done";
        job.result = result;
      })
      .catch((err) => {
        job.status = "error";
        job.error = err;
      })
      .finally(() => {
        job.finishedAt = Date.now();
        running -= 1;
        job.resolveSettled();
        pump();
      });
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  try {
    if (name === GENERATE_TOOL.name) return startGenerate(args);
    if (name === RESULT_TOOL.name) return await getResult(args, request, extra);
    return errorResult(`Unknown tool: ${name}`);
  } catch (err) {
    return errorResult(formatError(err));
  }
});

/** Validate, enqueue a generation job, and return immediately. */
function startGenerate(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return errorResult("[bad_request] `prompt` is required and must be a non-empty string.");
  }

  // Validate size and output_dir now so a bad request fails instantly instead
  // of after a 60-second agent session.
  const sizeCheck = normalizeSize(args.size);
  if (sizeCheck.error) {
    return errorResult(`[bad_request] Invalid \`size\`: ${sizeCheck.error}`);
  }

  let outputDir;
  if (args.output_dir != null) {
    if (typeof args.output_dir !== "string" || !args.output_dir.trim()) {
      return errorResult("[bad_request] `output_dir` must be a non-empty string when provided.");
    }
    outputDir = args.output_dir.trim();
    if (!path.isAbsolute(outputDir)) {
      return errorResult(
        `[bad_request] \`output_dir\` must be an absolute path (got "${args.output_dir}").`,
      );
    }
  }

  pruneJobs();
  const jobId = randomUUID();
  let resolveSettled;
  const settled = new Promise((r) => {
    resolveSettled = r;
  });
  const job = {
    status: "queued",
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    settled,
    resolveSettled,
    prompt: prompt.trim(),
    size: args.size,
    outputDir,
  };
  jobs.set(jobId, job);
  queue.push(jobId);
  pump();

  const position = queuePosition(jobId);
  const lines = [
    "Image generation started.",
    `job_id: ${jobId}`,
    `status: ${job.status}`,
  ];
  if (position) lines.push(`queue_position: ${position} (max ${config.maxConcurrent} concurrent)`);
  if (sizeCheck.note) lines.push(`size_note: ${sizeCheck.note}`);
  lines.push(
    "",
    "This takes ~50–90s once running. Call get_image_result with this job_id to fetch the PNG; " +
      'if it returns status "queued" or "running", call it again until status is "done".',
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function elapsedSecs(job) {
  return Math.round((Date.now() - (job.startedAt ?? job.queuedAt)) / 1000);
}

/** Retrieve (or wait briefly for) a job's result. */
async function getResult(args, request, extra) {
  const jobId = args.job_id;
  if (!jobId || typeof jobId !== "string") {
    return errorResult("[bad_request] `job_id` is required. Call generate_image first to get one.");
  }
  const job = jobs.get(jobId);
  if (!job) {
    return errorResult(
      `[unknown_job] No job found for job_id "${jobId}". It may have expired, or generation was never started — call generate_image first.`,
    );
  }

  // If not finished, long-poll up to POLL_WAIT_MS, emitting progress so clients
  // that DO honor it stay comfortable. Either way the call returns quickly.
  if (job.status === "queued" || job.status === "running") {
    const progressToken = request.params?._meta?.progressToken;
    let n = 0;
    const sendProgress = (message) => {
      if (progressToken === undefined || typeof extra?.sendNotification !== "function") return;
      n += 1;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken, progress: n, message } })
        .catch(() => {});
    };
    const heartbeat = setInterval(() => {
      const state = job.status === "queued" ? `Queued (position ${queuePosition(jobId)})` : "Generating image";
      sendProgress(`${state}… ${elapsedSecs(job)}s elapsed (typically 50–90s once running).`);
    }, 4000);

    let pollTimer;
    const pollWindow = new Promise((r) => {
      pollTimer = setTimeout(r, POLL_WAIT_MS);
    });
    try {
      await Promise.race([job.settled, pollWindow]);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(pollTimer);
    }
  }

  if (job.status === "queued" || job.status === "running") {
    const lines = [`status: ${job.status}`, `job_id: ${jobId}`, `elapsed: ${elapsedSecs(job)}s`];
    if (job.status === "queued") lines.push(`queue_position: ${queuePosition(jobId)}`);
    lines.push("", `Still ${job.status === "queued" ? "waiting for a slot" : "generating"}. Call get_image_result again with the same job_id.`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (job.status === "error") {
    const text = formatError(job.error);
    jobs.delete(jobId);
    return errorResult(text);
  }

  // Done.
  const result = job.result;
  jobs.delete(jobId);
  return await successResult(result);
}

async function successResult(result) {
  // Report the PNG's real dimensions; gpt-image-2 does not always return
  // exactly the requested size, and "auto" has no fixed size at all.
  const sizeParts = [];
  if (result.requestedSize !== result.size) sizeParts.push(`requested ${result.requestedSize}`);
  if (result.sizeNote) sizeParts.push(result.sizeNote);
  const lines = [
    `status: done`,
    `Image generated and saved.`,
    `Path: ${result.path}`,
    `Size: ${result.size}${sizeParts.length ? ` (${sizeParts.join("; ")})` : ""}`,
    `Bytes: ${result.bytes}`,
  ];
  if (result.codexHomeCopy && result.codexHomeCopy !== result.path) {
    lines.push(`Codex copy: ${result.codexHomeCopy}`);
  }

  const content = [{ type: "text", text: lines.join("\n") }];

  if (config.returnImage) {
    if (result.bytes <= config.maxInlineBytes) {
      try {
        const data = await fs.readFile(result.path);
        content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
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

function formatError(err) {
  if (err instanceof PixmithError) {
    const detail = err.detail ? `\n\nDetail:\n${err.detail}` : "";
    return `[${err.kind}] ${err.message}${detail}`;
  }
  return `Unexpected error: ${err?.message || String(err)}`;
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `Pixmith ${config.version} MCP server running (codex: ${config.codexBin}, output: ${config.defaultOutputDir}, max concurrent: ${config.maxConcurrent}, poll wait: ${POLL_WAIT_SECS}s)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Pixmith failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
