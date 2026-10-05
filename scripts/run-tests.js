#!/usr/bin/env node
// Runs every test/*.test.js. `node --test test/` stopped accepting a directory in
// Node 21, and Node 18/20 do not expand globs, so the file list is built here.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join("test", f));
const { status } = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(status ?? 1);
