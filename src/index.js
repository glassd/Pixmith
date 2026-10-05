#!/usr/bin/env node
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config, configWarnings } from "./config.js";
import { generateImage, killAllCodex } from "./codex.js";
import { ImageHistory } from "./history.js";
import { DurationStats, JobManager } from "./jobs.js";
import { createServer } from "./server.js";

// Wiring only: the MCP server is in server.js, the tools in tools.js, the queue
// in jobs.js, and the Codex driver in codex.js.

const history = new ImageHistory({ file: path.join(config.stateDir, "history.jsonl") });
const jobs = new JobManager({
  generate: generateImage,
  maxConcurrent: config.maxConcurrent,
  stats: new DurationStats({ file: path.join(config.stateDir, "stats.json") }),
  history,
  log: (job, line) => process.stderr.write(`[codex ${job.id.slice(0, 8)}] ${line}\n`),
});
const server = createServer({ jobs, config, history });

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
  if (config.codexBinNote) process.stderr.write(`Pixmith: ${config.codexBinNote}\n`);
  for (const warning of configWarnings) process.stderr.write(`Pixmith: ${warning}\n`);
}

main().catch((err) => {
  process.stderr.write(`Pixmith failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
