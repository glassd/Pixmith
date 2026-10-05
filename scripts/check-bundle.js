#!/usr/bin/env node
// Checks a built pixmith.mcpb (run by CI after `npm run bundle`): everything the
// server needs at run time is inside, and nothing that only belongs in the repo.
// Usage: node scripts/check-bundle.js [dist/pixmith.mcpb]
import { execFileSync } from "node:child_process";

const bundle = process.argv[2] || "dist/pixmith.mcpb";
// An .mcpb is a zip; `unzip -Z1` lists one entry per line.
const entries = new Set(execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" }).split("\n").filter(Boolean));

const required = [
  "manifest.json",
  "assets/icon.png",
  "src/index.js",
  "src/preview-worker.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js",
  "node_modules/pngjs/package.json",
  "node_modules/jpeg-js/package.json",
];
// Repo-only files, and dev tools (a bundle must be built after `npm ci --omit=dev`).
const forbidden =
  /^(test|fixtures|scripts|\.github|images|\.pixmith|dist)\/|^assets\/hero\.png$|^\.env|^node_modules\/(eslint|@eslint|prettier|globals)\//;

const missing = required.filter((f) => !entries.has(f));
const extra = [...entries].filter((f) => forbidden.test(f));
console.log(`${bundle}: ${entries.size} entries`);
if (missing.length) console.error(`Missing:\n  ${missing.join("\n  ")}`);
if (extra.length) console.error(`Should not be bundled:\n  ${extra.slice(0, 20).join("\n  ")}`);
process.exit(missing.length || extra.length ? 1 : 0);
