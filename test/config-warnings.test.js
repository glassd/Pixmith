import { test } from "node:test";
import assert from "node:assert/strict";

// config.js reads the environment at import time, so this file sets it first.
process.env.PIXMITH_CODEX_MODEL = "bad model; rm -rf";
process.env.PIXMITH_CODEX_EFFORT = "low";
const { config, configWarnings } = await import("../src/config.js");

test("settings passed to the Codex command line are validated, and rejects are reported", () => {
  assert.equal(config.codexModel, null, "an unsafe model name never reaches the command line");
  assert.equal(config.codexEffort, "low");
  assert.equal(configWarnings.length, 1);
  assert.match(configWarnings[0], /PIXMITH_CODEX_MODEL="bad model; rm -rf" is not a valid value and was ignored/);
});
