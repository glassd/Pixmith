#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { generateImage, PixmithError } from "./codex.js";

// Image generation takes ~50–90s — longer than the per-request timeout many MCP
// clients (e.g. Claude Desktop) enforce, and some clients do NOT extend that
// timeout on progress notifications. So Pixmith never blocks on the long call:
// `generate_image` starts a background job and returns instantly with a job_id,
// and `get_image_result` retrieves it, waiting at most POLL_WAIT_MS per call.
// No single tool call runs long enough to trip a client-side timeout.

// Long-poll window per get_image_result call. Must stay under the client's
// per-request timeout (Claude Desktop ~60s); 25s leaves comfortable margin.
// Lower it via PIXMITH_POLL_WAIT_MS if your client times out faster.
const POLL_WAIT_MS = Math.min(
  55_000,
  Math.max(2_000, Number.parseInt(process.env.PIXMITH_POLL_WAIT_MS || "", 10) || 25_000),
);
const JOB_TTL_MS = 15 * 60 * 1000; // forget finished jobs after this long

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          'Optional. "auto", a shortcut "1K"/"2K"/"4K", or explicit "WIDTHxHEIGHT" (e.g. "1024x1024", "1536x1024"). ' +
          "Each edge 256–3840. Defaults to 1024x1024.",
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
    "Retrieve the result of a `generate_image` job by its job_id. Waits up to ~25 seconds for the image to finish, " +
    "then returns. If the returned status is \"running\", call this again with the SAME job_id — repeat until status is " +
    "\"done\" (typically 2–4 calls for one image). On success it returns the saved absolute PNG path and, when small enough, " +
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
  { name: "pixmith", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GENERATE_TOOL, RESULT_TOOL],
}));

/** jobId -> { status, startedAt, finishedAt, result, error, settled, prompt } */
const jobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
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

/** Start a background generation job and return immediately. */
function startGenerate(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return errorResult("[bad_request] `prompt` is required and must be a non-empty string.");
  }

  pruneJobs();
  const jobId = randomUUID();
  const job = {
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    prompt: prompt.trim(),
  };

  job.settled = generateImage({
    prompt,
    size: args.size,
    outputDir: args.output_dir,
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
    });

  jobs.set(jobId, job);

  return {
    content: [
      {
        type: "text",
        text:
          `Image generation started.\n` +
          `job_id: ${jobId}\n` +
          `status: running\n\n` +
          `This takes ~50–90s. Call get_image_result with this job_id to fetch the PNG; ` +
          `if it returns status "running", call it again until status is "done".`,
      },
    ],
  };
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

  // If still running, long-poll up to POLL_WAIT_MS, emitting progress so clients
  // that DO honor it stay comfortable. Either way the call returns quickly.
  if (job.status === "running") {
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
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      sendProgress(`Generating image… ${secs}s elapsed (typically 50–90s).`);
    }, 4000);
    try {
      await Promise.race([job.settled, sleep(POLL_WAIT_MS)]);
    } finally {
      clearInterval(heartbeat);
    }
  }

  if (job.status === "running") {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return {
      content: [
        {
          type: "text",
          text:
            `status: running\njob_id: ${jobId}\nelapsed: ${secs}s\n\n` +
            `Still generating. Call get_image_result again with the same job_id.`,
        },
      ],
    };
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
  const lines = [
    `status: done`,
    `Image generated and saved.`,
    `Path: ${result.path}`,
    `Size: ${result.size}${result.sizeNote ? ` (${result.sizeNote})` : ""}`,
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
    `Pixmith MCP server running (codex: ${config.codexBin}, output: ${config.defaultOutputDir})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Pixmith failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
