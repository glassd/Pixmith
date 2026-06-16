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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL.name) {
    return errorResult(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments || {};
  const prompt = args.prompt;
  const size = args.size;
  const outputDir = args.output_dir;

  try {
    const result = await generateImage({
      prompt,
      size,
      outputDir,
      // stderr is Codex's progress stream; we keep it server-side (stderr of
      // this process) so it never corrupts the stdio JSON-RPC channel.
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
