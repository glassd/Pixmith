#!/usr/bin/env node
import { promises as fs } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { generateImage, PixmithError } from "./codex.js";

const TOOL = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using the OpenAI Codex CLI (gpt-image-2 via the $imagegen skill). " +
    "Generation runs on the user's signed-in ChatGPT subscription — no API key is used, and it counts toward " +
    "the ChatGPT plan's usage limits. Returns the absolute path to a saved PNG (and the image inline when small enough).",
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

const server = new Server(
  { name: "pixmith", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== TOOL.name) {
    return errorResult(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments || {};
  const prompt = args.prompt;
  const size = args.size;
  const outputDir = args.output_dir;

  // Image generation takes ~50–90s. Most MCP clients enforce a per-request
  // timeout (often ~60s) but reset it whenever they receive a progress
  // notification. So we stream progress while Codex runs — both forwarding
  // Codex's own output and a steady heartbeat for the quiet stretches — to keep
  // the client's timeout from firing on a generation that is actually working.
  const progressToken = request.params?._meta?.progressToken;
  let progressCount = 0;
  const startedAt = Date.now();

  const sendProgress = (message) => {
    if (progressToken === undefined || typeof extra?.sendNotification !== "function") {
      return;
    }
    progressCount += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: progressCount, message },
      })
      .catch(() => {});
  };

  // Heartbeat: emit a clean progress message every few seconds so the client
  // keeps the request alive even while Codex is silent. We deliberately do NOT
  // forward raw Codex stderr here — it echoes our prompt and skill docs, which
  // is noisy and misleading to a user. Full Codex output still goes to this
  // process's stderr (below) for server-side debugging.
  sendProgress("Starting Codex image generation…");
  const heartbeat = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    sendProgress(`Generating image on your ChatGPT subscription… ${secs}s elapsed (typically 50–90s).`);
  }, 4000);

  try {
    const result = await generateImage({
      prompt,
      size,
      outputDir,
      // Codex streams progress to stderr. Mirror it to THIS process's stderr
      // (never stdout — that is the JSON-RPC channel) for debugging only.
      onProgress: (line) => process.stderr.write(`[codex] ${line}\n`),
    });

    const lines = [
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
          content.push({
            type: "image",
            data: data.toString("base64"),
            mimeType: "image/png",
          });
        } catch (err) {
          content.push({
            type: "text",
            text: `(Could not inline image: ${err.message})`,
          });
        }
      } else {
        content.push({
          type: "text",
          text: `(Image not inlined: ${result.bytes} bytes exceeds PIXMITH_MAX_INLINE_BYTES=${config.maxInlineBytes}. Open it from the path above.)`,
        });
      }
    }

    return { content };
  } catch (err) {
    if (err instanceof PixmithError) {
      const detail = err.detail ? `\n\nDetail:\n${err.detail}` : "";
      return errorResult(`[${err.kind}] ${err.message}${detail}`);
    }
    return errorResult(`Unexpected error: ${err?.message || String(err)}`);
  } finally {
    clearInterval(heartbeat);
  }
});

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Announce on stderr so users see the server is alive without polluting stdio.
  process.stderr.write(
    `Pixmith MCP server running (codex: ${config.codexBin}, output: ${config.defaultOutputDir})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Pixmith failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
