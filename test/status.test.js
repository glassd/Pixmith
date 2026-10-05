import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkStatus, parseCodexVersion, parseLoginStatus } from "../src/status.js";

test("parseCodexVersion: finds the version in Codex's output", () => {
  assert.equal(parseCodexVersion("codex-cli 0.46.0\n"), "0.46.0");
  assert.equal(parseCodexVersion("codex-cli 1.2.3-alpha.4"), "1.2.3-alpha.4");
  assert.equal(parseCodexVersion("command not found"), null);
  assert.equal(parseCodexVersion(undefined), null);
});

test("parseLoginStatus: ChatGPT, API key, signed out, and versions that cannot say", () => {
  const run = (text, code = 0, error = null) => parseLoginStatus({ code, stdout: "", stderr: text, error });
  assert.equal(run("Logged in using ChatGPT"), "chatgpt");
  assert.equal(run("Logged in using an API key - sk-proj-***ABCD"), "api_key");
  assert.equal(run("Logged in"), "signed_in");
  assert.equal(run("Not logged in", 1), "signed_out");
  assert.equal(run("error: unrecognized subcommand 'status'", 2), "unknown");
  assert.equal(run("something went wrong", 1), "unknown");
  assert.equal(run("", null, "timeout"), "unknown");
});

/** A config like config.js builds, with its folders in a temp dir. */
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-status-"));
  const bin = path.join(dir, "codex");
  await fs.writeFile(bin, "");
  const config = {
    version: "9.9.9",
    codexBin: bin,
    codexBinNote: null,
    codexHome: path.join(dir, "codex-home"),
    defaultOutputDir: path.join(dir, "images"),
    stateDir: path.join(dir, "state"),
    maxConcurrent: 1,
    pollWaitMs: 45_000,
    timeoutMs: 300_000,
    sandbox: "workspace-write",
    bypassSandbox: false,
    creditsPolicy: "ask",
    codexModel: null,
    codexEffort: null,
    usageWarnPercent: 80,
  };
  // A fake `codex` for the two commands checkStatus runs.
  const commands = { version: { code: 0, stdout: "codex-cli 0.46.0\n", stderr: "", error: null }, login: { code: 0, stdout: "", stderr: "Logged in using ChatGPT\n", error: null } };
  const runCommand = async (args) => (args[0] === "--version" ? commands.version : commands.login);
  return { dir, config, commands, runCommand, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const USAGE = (usedPercent) => ({
  at: Date.now(),
  plan: "plus",
  windows: [{ label: "5-hour", minutes: 300, usedPercent, resetsAt: Date.now() + 3_600_000 }],
  credits: { unlimited: false, balance: 0, available: false },
  reachedType: null,
});

test("checkStatus: everything in order is ready", async () => {
  const t = await setup();
  try {
    const r = await checkStatus({
      config: t.config,
      runCommand: t.runCommand,
      readUsage: async () => USAGE(12),
      jobs: { counts: () => ({ running: 1, queued: 2 }) },
    });
    assert.equal(r.status, "ready");
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.codex, { bin: t.config.codexBin, found: true, version: "0.46.0" });
    assert.deepEqual(r.sign_in, { state: "chatgpt" });
    assert.equal(r.usage.windows[0].used_percent, 12);
    assert.equal(r.limit_reached, false);
    assert.deepEqual(r.output_dir, { path: t.config.defaultOutputDir, writable: true });
    assert.deepEqual(r.jobs, { running: 1, queued: 2 });
    assert.equal(r.settings.sandbox, "workspace-write");
    await fs.access(t.config.defaultOutputDir); // created on the way
  } finally {
    await t.cleanup();
  }
});

test("checkStatus: each problem comes with a next step", async () => {
  const t = await setup();
  try {
    // Missing binary: a path that does not exist (on Windows a .cmd shim reports no ENOENT).
    t.config.codexBin = path.join(t.dir, "gone", "codex");
    t.commands.version = { code: null, stdout: "", stderr: "", error: "ENOENT" };
    t.commands.login = { code: null, stdout: "", stderr: "", error: "ENOENT" };
    let r = await checkStatus({ config: t.config, runCommand: t.runCommand });
    assert.equal(r.status, "problems");
    assert.deepEqual(r.problems.map((p) => p.kind), ["binary_missing"]);
    assert.match(r.problems[0].next_step, /CODEX_BIN/);
    assert.equal(r.codex.found, false);

    // Signed out, plan used up, output folder unwritable.
    const fresh = await setup();
    try {
      fresh.commands.login = { code: 1, stdout: "", stderr: "Not logged in\n", error: null };
      await fs.writeFile(path.join(fresh.dir, "blocker"), "a file, not a folder");
      fresh.config.defaultOutputDir = path.join(fresh.dir, "blocker", "images");
      r = await checkStatus({ config: fresh.config, runCommand: fresh.runCommand, readUsage: async () => USAGE(100) });
      assert.deepEqual(r.problems.map((p) => p.kind).sort(), ["not_signed_in", "output_dir_not_writable", "usage_limit"]);
      assert.equal(r.limit_reached, true);
      assert.ok(r.problems.every((p) => p.message && p.next_step));
    } finally {
      await fresh.cleanup();
    }
  } finally {
    await t.cleanup();
  }
});

test("checkStatus: warnings for an API-key sign-in, an old Codex, and config problems", async () => {
  const t = await setup();
  try {
    t.commands.login = { code: 0, stdout: "", stderr: "Logged in using an API key - sk-proj-***ABCD\n", error: null };
    t.config.codexBinNote = "CODEX_BIN is stale.";
    let r = await checkStatus({ config: t.config, runCommand: t.runCommand, configWarnings: ['PIXMITH_SANDBOX="x" was ignored.'] });
    assert.equal(r.status, "ready", "warnings alone do not stop jobs");
    assert.equal(r.sign_in.state, "api_key");
    assert.equal(r.warnings.length, 3);
    assert.ok(r.warnings.some((w) => /billed to that API account/.test(w)));
    assert.ok(!JSON.stringify(r).includes("sk-proj"), "nothing from the key is passed on");

    // An old Codex without `login status`: only whether the credentials file exists is checked.
    t.commands.login = { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'status'\n", error: null };
    r = await checkStatus({ config: t.config, runCommand: t.runCommand });
    assert.equal(r.sign_in.state, "unknown");
    assert.match(r.sign_in.detail, /probably not signed in/);
    await fs.mkdir(t.config.codexHome, { recursive: true });
    await fs.writeFile(path.join(t.config.codexHome, "auth.json"), "{}");
    r = await checkStatus({ config: t.config, runCommand: t.runCommand });
    assert.match(r.sign_in.detail, /probably signed in/);
  } finally {
    await t.cleanup();
  }
});
