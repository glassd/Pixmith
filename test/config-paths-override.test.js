import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// The plugin sets PIXMITH_DEFAULT_OUTPUT_DIR; a user's own PIXMITH_OUTPUT_DIR must win.
process.env.PIXMITH_DEFAULT_OUTPUT_DIR = "~/Pictures/Pixmith";
process.env.PIXMITH_OUTPUT_DIR = "~/Desktop/renders";
const { config } = await import("../src/config.js");

test("the user's PIXMITH_OUTPUT_DIR overrides the installer default", () => {
  assert.equal(config.defaultOutputDir, path.join(os.homedir(), "Desktop", "renders"));
});
