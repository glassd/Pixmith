import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// config.js reads the environment at import time, so this file sets it first.
// These mirror what the Claude Code plugin manifest passes to the server.
delete process.env.PIXMITH_OUTPUT_DIR;
process.env.PIXMITH_DEFAULT_OUTPUT_DIR = "~/Pictures/Pixmith";
process.env.PIXMITH_STATE_DIR = "${CLAUDE_PLUGIN_DATA}/state";
const { config, configWarnings, expandHome } = await import("../src/config.js");

test("expandHome: expands a leading ~ only", () => {
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/Pictures/Pixmith", "/home/u"), path.join("/home/u", "Pictures/Pixmith"));
  assert.equal(expandHome("~\\Pictures", "C:\\Users\\u"), path.join("C:\\Users\\u", "Pictures"));
  assert.equal(expandHome("/abs/~/x", "/home/u"), "/abs/~/x");
  assert.equal(expandHome("~other/x", "/home/u"), "~other/x");
});

test("the installer's ~ default output dir resolves into the home directory", () => {
  assert.equal(config.defaultOutputDir, path.join(os.homedir(), "Pictures", "Pixmith"));
});

test("an unexpanded ${...} path is ignored with a startup warning", () => {
  assert.ok(!config.stateDir.includes("${"), config.stateDir);
  assert.ok(config.stateDir.endsWith(`${path.sep}.pixmith`), config.stateDir);
  assert.ok(configWarnings.some((w) => /PIXMITH_STATE_DIR=.*unexpanded variable/.test(w)));
});
