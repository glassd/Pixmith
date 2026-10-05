#!/usr/bin/env node
// Builds dist/pixmith.mcpb (npm run bundle). The files that ship are copied to
// a temporary folder and only production dependencies are installed there, so
// dev tools in the local node_modules (ESLint, Prettier) never get bundled.
// The result is then checked with scripts/check-bundle.js.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = path.join(root, "dist", "pixmith.mcpb");
const shipped = ["manifest.json", "package.json", "package-lock.json", ".mcpbignore", "README.md", "LICENSE", "src", "assets/icon.png"];

// npm and npx are .cmd shims on Windows, which only run through a shell.
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const stage = mkdtempSync(path.join(os.tmpdir(), "pixmith-bundle-"));
try {
  for (const f of shipped) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  mkdirSync(path.dirname(out), { recursive: true });
  run("npx", ["--yes", MCPB, "pack", stage, out], root);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
run(process.execPath, [path.join(root, "scripts", "check-bundle.js"), out], root);
