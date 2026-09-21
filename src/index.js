#!/usr/bin/env node
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { generateImage, killAllCodex } from "./codex.js";
import { DurationStats, JobManager } from "./jobs.js";
import { createTools } from "./tools.js";

// Wiring only: the tools live in tools.js, the queue in jobs.js, and the Codex
// driver in codex.js.

const jobs = new JobManager({
  generate: generateImage,
  maxConcurrent: config.maxConcurrent,
  stats: new DurationStats({ file: path.join(config.stateDir, "stats.json") }),
  log: (job, line) => process.stderr.write(`[codex ${job.id.slice(0, 8)}] ${line}\n`),
});
const { tools, call } = createTools({ jobs, config });

const server = new Server({ name: "pixmith", version: config.version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
  call(request.params.name, request.params.arguments || {}, request, extra),
);

// When the client goes away, stop any Codex sessions still running so they do
// not keep spending the ChatGPT plan's quota on images nobody will collect.
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  jobs.shutdown();
  killAllCodex();
  setTimeout(() => process.exit(code), 250).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

async function main() {
  const transport = new StdioServerTransport();
  server.onclose = () => shutdown(0);
  await server.connect(transport);
  process.stderr.write(
    `Pixmith ${config.version} MCP server running (codex: ${config.codexBin}, output: ${config.defaultOutputDir}, ` +
      `max concurrent: ${config.maxConcurrent}, wait window: ${Math.round(config.pollWaitMs / 1000)}s)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Pixmith failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
