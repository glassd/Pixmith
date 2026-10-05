import { constants, promises as fs } from "node:fs";
import path from "node:path";

import { runCodexCommand } from "./codex.js";
import { limitReached, usageSummary } from "./usage.js";

// pixmith_status: everything that decides whether an image can be made, checked
// without making one. It runs `codex --version` and `codex login status` (which
// cost no plan usage), reads the latest plan-usage snapshot, and checks the
// folders Pixmith writes to. It never reads Codex's credentials: at most it
// checks that the credentials file exists, when Codex cannot say.

/** "codex-cli 0.46.0" -> "0.46.0"; null when there is no version in the text. */
export function parseCodexVersion(text) {
  const m = String(text ?? "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  return m ? m[1] : null;
}

/**
 * Interpret `codex login status`. Returns one of
 *   "chatgpt"     signed in with a ChatGPT account (what Pixmith is for)
 *   "api_key"     signed in with an API key (usage is billed to the API account)
 *   "signed_in"   signed in some other way
 *   "signed_out"  not signed in
 *   "unknown"     this Codex cannot say (no `login status`), or it failed
 */
export function parseLoginStatus({ code, stdout, stderr, error }) {
  if (error) return "unknown";
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/not (logged|signed) in/.test(text)) return "signed_out";
  if (/(unrecognized|unexpected|unknown|invalid)[^\n]*(subcommand|argument|command)/.test(text)) return "unknown";
  if (code !== 0) return "unknown";
  if (text.includes("chatgpt")) return "chatgpt";
  if (text.includes("api key")) return "api_key";
  return /(logged|signed) in/.test(text) ? "signed_in" : "unknown";
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether Pixmith can write into `dir`, creating it if needed. */
async function writable(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check everything and return a report (the shape of STATUS_OUTPUT_SCHEMA):
 * `status` is "ready" when nothing stands in the way of a job, else
 * "problems", and every problem names its next step.
 */
export async function checkStatus({
  config,
  configWarnings = [],
  jobs = null,
  readUsage = async () => null,
  runCommand = runCodexCommand,
}) {
  const [versionRun, loginRun, usage, outputOk, stateOk] = await Promise.all([
    runCommand(["--version"]),
    runCommand(["login", "status"]),
    readUsage().catch(() => null),
    writable(config.defaultOutputDir),
    writable(config.stateDir),
  ]);

  const problems = [];
  const warnings = [...configWarnings];
  if (config.codexBinNote) warnings.push(config.codexBinNote);

  // ---- Codex itself. Through cmd.exe (a Windows .cmd shim) a missing binary
  // is not ENOENT but "is not recognized", so a path that does not exist
  // counts as missing too.
  const bin = config.codexBin;
  const looksLikePath = path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\");
  const missing =
    versionRun.error === "ENOENT" ||
    /is not recognized as an internal or external command/i.test(versionRun.stderr) ||
    (looksLikePath && !(await exists(bin)));
  const version = parseCodexVersion(versionRun.stdout) ?? parseCodexVersion(versionRun.stderr);
  const codex = { bin: config.codexBin, found: !missing && versionRun.error !== "unsafe_path", version };
  if (missing) {
    problems.push({
      kind: "binary_missing",
      message: `Codex was not found at "${config.codexBin}".`,
      next_step: "Install the Codex CLI or the Codex desktop app, or set CODEX_BIN to its absolute path.",
    });
  } else if (versionRun.error === "unsafe_path") {
    problems.push({ kind: "bad_request", message: versionRun.stderr, next_step: "Set CODEX_BIN to a codex.exe." });
  } else if (!version) {
    warnings.push(
      `Codex at "${config.codexBin}" did not report a version (${versionRun.error ?? `exit code ${versionRun.code}`}); it may not work.`,
    );
  }

  // ---- signed in?
  let signIn = { state: missing ? "unknown" : parseLoginStatus(loginRun), detail: "" };
  if (signIn.state === "unknown" && !missing) {
    // An older Codex has no `login status`. Whether its credentials file is
    // there is the best remaining hint; the file itself is never read.
    const authFile = path.join(config.codexHome, "auth.json");
    signIn = (await exists(authFile))
      ? { state: "unknown", detail: "This Codex cannot report its sign-in, but its credentials file exists, so it is probably signed in." }
      : { state: "unknown", detail: "This Codex cannot report its sign-in, and no credentials file was found; it is probably not signed in." };
  }
  if (signIn.state === "signed_out") {
    problems.push({
      kind: "not_signed_in",
      message: "Codex is not signed in.",
      next_step: "Run `codex login` (or sign in from the Codex app) with your ChatGPT account.",
    });
  } else if (signIn.state === "api_key") {
    warnings.push(
      "Codex is signed in with an API key, so images are billed to that API account rather than your ChatGPT plan. Run `codex login` with your ChatGPT account to use the plan.",
    );
  } else if (signIn.state === "unknown" && !missing) {
    warnings.push(signIn.detail || "Could not tell whether Codex is signed in.");
  }

  // ---- plan usage
  const opts = { warnPercent: config.usageWarnPercent ?? 80 };
  const reached = usage ? limitReached(usage) : false;
  if (reached) {
    problems.push({
      kind: "usage_limit",
      message: "The ChatGPT plan's Codex limit is used up (or nearly), so a new job would run on paid credits or fail.",
      next_step: "Wait for the limit to reset, or agree to use credits (use_credits: true) when a job asks.",
    });
  }

  // ---- folders
  if (!outputOk) {
    problems.push({
      kind: "output_dir_not_writable",
      message: `The default output folder ${config.defaultOutputDir} cannot be written to.`,
      next_step: "Set PIXMITH_OUTPUT_DIR to a writable folder, or pass output_dir on each call.",
    });
  }
  if (!stateOk) {
    warnings.push(`Pixmith's state folder ${config.stateDir} cannot be written to, so time estimates and the image history are not saved.`);
  }

  const counts = jobs?.counts?.() ?? { running: 0, queued: 0 };
  return {
    status: problems.length ? "problems" : "ready",
    pixmith_version: config.version,
    node_version: process.versions.node,
    platform: process.platform,
    codex,
    sign_in: signIn.detail ? signIn : { state: signIn.state },
    usage: usageSummary(usage, opts),
    limit_reached: reached,
    output_dir: { path: config.defaultOutputDir, writable: outputOk },
    state_dir: { path: config.stateDir, writable: stateOk },
    jobs: counts,
    settings: {
      max_concurrent: config.maxConcurrent,
      wait_seconds: Math.round(config.pollWaitMs / 1000),
      timeout_seconds: Math.round(config.timeoutMs / 1000),
      sandbox: config.bypassSandbox ? "bypassed" : config.sandbox,
      credits_policy: config.creditsPolicy,
      codex_model: config.codexModel ?? null,
      codex_effort: config.codexEffort ?? null,
    },
    problems,
    warnings,
  };
}
