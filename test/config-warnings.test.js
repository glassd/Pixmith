import { test } from "node:test";
import assert from "node:assert/strict";

// config.js reads the environment at import time, so this file sets it first.
process.env.PIXMITH_CODEX_MODEL = "bad model; rm -rf";
process.env.PIXMITH_CODEX_EFFORT = "low";
process.env.PIXMITH_USE_CREDITS = "sometimes";
const { config, configWarnings } = await import("../src/config.js");

test("settings passed to the Codex command line are validated, and rejects are reported", () => {
  assert.equal(config.codexModel, null, "an unsafe model name never reaches the command line");
  assert.equal(config.codexEffort, "low");
  assert.equal(config.creditsPolicy, "ask", "an unknown credits policy falls back to asking");
  assert.equal(configWarnings.length, 2);
  assert.ok(configWarnings.some((w) => /PIXMITH_CODEX_MODEL="bad model; rm -rf" is not a valid value and was ignored/.test(w)));
  assert.ok(configWarnings.some((w) => /PIXMITH_USE_CREDITS="sometimes" is not one of ask, always, never; using "ask"/.test(w)));
});
