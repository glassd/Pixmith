import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Central configuration for Pixmith, resolved from environment variables with
 * sensible defaults. Nothing here reads or exposes any Codex auth tokens.
 *
 * Everything here is cross-platform (macOS, Windows, Linux): paths are derived
 * with the `path`/`url` modules and the Codex binary is auto-located across the
 * common per-OS install locations, falling back to whatever `codex` is on PATH.
 */

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envStr(name, fallback) {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

/** Settings that were present but unusable; index.js reports them at startup. */
export const configWarnings = [];

/**
 * A string setting that is passed to the Codex command line. It is ignored —
 * with a startup warning — unless it matches `pattern`.
 */
function envPattern(name, pattern) {
  const v = envStr(name, null);
  if (!v) return null;
  if (pattern.test(v)) return v;
  configWarnings.push(`${name}="${v}" is not a valid value and was ignored; Codex's own default is used instead.`);
  return null;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

const HOME = os.homedir();
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Read the version from package.json so the server never drifts from it. */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Candidate Codex binary locations per platform, tried in order. The first that
 * exists wins; otherwise we fall back to the bare command name `codex` and let
 * the OS resolve it on PATH (so a globally-installed CLI just works).
 */
function codexCandidates() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(localAppData, "Programs", "codex", "codex.exe"),
      path.join(localAppData, "Programs", "Codex", "codex.exe"),
      path.join(localAppData, "Programs", "@openai", "codex", "codex.exe"),
      path.join(programFiles, "Codex", "codex.exe"),
      path.join(appData, "npm", "codex.cmd"),
      "codex.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(HOME, "Applications/Codex.app/Contents/Resources/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      // The standalone installer's location. It must be listed explicitly: apps
      // launched from the Dock (e.g. Claude Desktop) do not inherit the shell's
      // PATH, so a bare `codex` would not resolve there.
      path.join(HOME, ".local/bin/codex"),
      path.join(HOME, "bin/codex"),
    ];
  }
  // linux and others
  return [
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(HOME, ".local/bin/codex"),
    path.join(HOME, "bin/codex"),
  ];
}

const looksLikePath = (p) => path.isAbsolute(p) || p.includes("/") || p.includes("\\");

/**
 * Resolve the Codex binary: explicit override, else first existing candidate,
 * else the bare command on PATH. Returns { bin, note }.
 *
 * A CODEX_BIN that points at a file which no longer exists (Codex was moved or
 * reinstalled after the MCP client was configured) does not fail every job:
 * when auto-detection finds a working binary it is used instead, and `note`
 * says so, so the stale setting can be cleaned up.
 */
export function resolveCodexBin(override, candidates, exists = fssync.existsSync) {
  const found = candidates.find((c) => {
    try {
      return path.isAbsolute(c) && exists(c);
    } catch {
      return false;
    }
  });
  if (override) {
    if (!looksLikePath(override) || exists(override)) return { bin: override, note: null };
    if (found) {
      return {
        bin: found,
        note: `CODEX_BIN is set to "${override}", which does not exist. Pixmith used the auto-detected "${found}" instead — update or remove CODEX_BIN in your MCP client's config.`,
      };
    }
    return { bin: override, note: null }; // nothing better; the error will name this path
  }
  return { bin: found ?? "codex", note: null }; // bare name: rely on PATH
}

const codex = resolveCodexBin(envStr("CODEX_BIN", null), codexCandidates());

export const config = {
  version: readPackageVersion(),

  // Path to the Codex binary, or a bare command resolved on PATH.
  codexBin: codex.bin,
  // Set when a stale CODEX_BIN override was replaced by auto-detection.
  codexBinNote: codex.note,
  // Every candidate we considered — used to build a helpful "not found" error.
  codexCandidates: codexCandidates(),

  // Sandbox policy passed to `codex exec` (when the OS sandbox is in use).
  sandbox: envStr("PIXMITH_SANDBOX", "workspace-write"),

  // Bypass Codex's OS sandbox entirely. Codex sandboxing is implemented with
  // macOS Seatbelt / Linux Landlock and has no Windows equivalent, so on Windows
  // the sandboxed file-save is blocked. Default: bypass on Windows, sandbox
  // elsewhere. Override with PIXMITH_BYPASS_SANDBOX=true|false.
  bypassSandbox: envBool("PIXMITH_BYPASS_SANDBOX", process.platform === "win32"),

  // Where images land by default when the caller does not pass output_dir.
  // Resolved against the project root so a relative override still works.
  defaultOutputDir: path.resolve(
    PROJECT_ROOT,
    envStr("PIXMITH_OUTPUT_DIR", path.join(PROJECT_ROOT, "images")),
  ),

  // Stop Codex as soon as the finished PNG is on disk instead of waiting for
  // the agent's closing "DONE" turn (which re-uploads the image to the model).
  earlyExit: envBool("PIXMITH_EARLY_EXIT", true),

  // Give the agent the image prompt in a file instead of making it retype the
  // text into its tool call (the slowest part of the agent wrapper for long
  // prompts). Relies on a POSIX `cat`, so it is off on Windows by default.
  fastPrompt: envBool("PIXMITH_FAST_PROMPT", process.platform !== "win32"),

  // Optional model / reasoning effort for the agent that wraps the image_gen
  // call. Unset = whatever ~/.codex/config.toml says. The image model itself
  // (gpt-image-2) is not affected.
  codexModel: envPattern("PIXMITH_CODEX_MODEL", /^[\w.:-]+$/),
  codexEffort: envPattern("PIXMITH_CODEX_EFFORT", /^[a-z]+$/),

  // CODEX_HOME holds generated_images/<session>/ig_*.png and sessions/**.jsonl.
  codexHome: envStr("CODEX_HOME", path.join(HOME, ".codex")),

  // Hard timeout for a single generation, in milliseconds.
  timeoutMs: envInt("PIXMITH_TIMEOUT_MS", 5 * 60 * 1000),

  // How many Codex generations may run at once. Each one is a full agent
  // session against the user's ChatGPT quota, so keep this small. Extra
  // requests queue and are reported as status "queued".
  maxConcurrent: envInt("PIXMITH_MAX_CONCURRENT", 1),

  // How long any single tool call may wait for a job before answering
  // "still running". A typical generation (~30-40s) fits inside the default, so
  // most images come back from the very first call. Must stay under the
  // client's per-request timeout (commonly 60s) — lower it for stricter clients.
  pollWaitMs: Math.min(55_000, Math.max(2_000, envInt("PIXMITH_POLL_WAIT_MS", 45_000))),

  // Extra time a call may wait past pollWaitMs when the job is already in its
  // final stage (Codex done, image being collected). Capped so that no call
  // ever exceeds 58s in total.
  get finishGraceMs() {
    return Math.max(0, Math.min(8_000, 58_000 - this.pollWaitMs));
  },

  // Where Pixmith keeps its own small state (recent job durations, used to
  // estimate how long a generation will take). Git-ignored.
  stateDir: path.resolve(PROJECT_ROOT, envStr("PIXMITH_STATE_DIR", path.join(PROJECT_ROOT, ".pixmith"))),

  // Whether to inline the PNG as MCP image content (base64), and the size cap.
  returnImage: envBool("PIXMITH_RETURN_IMAGE", true),
  maxInlineBytes: envInt("PIXMITH_MAX_INLINE_BYTES", 6 * 1024 * 1024),
};

/**
 * gpt-image-2 size constraints (from the imagegen skill): `auto`, or
 * WIDTHxHEIGHT where each edge is a multiple of 16, the longest edge is at most
 * 3840px, the long:short ratio is at most 3:1, and the pixel count lies between
 * 655,360 and 8,294,400.
 */
export const SIZE_LIMITS = Object.freeze({
  step: 16,
  maxEdge: 3840,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
});

const SIZE_SHORTCUTS = Object.freeze({
  "1k": "1024x1024",
  "2k": "2048x2048",
  "4k": "3840x2160",
});

/**
 * Normalize a requested size into something the imagegen skill accepts.
 * Accepts: "auto", "1K"/"2K"/"4K" shortcuts, or explicit "WIDTHxHEIGHT".
 *
 * Returns { value, note, error }:
 *  - value: the string to feed Codex, or null when the request is invalid.
 *  - note:  explains any coercion (edges are rounded to a multiple of 16).
 *  - error: a human-readable reason when the size cannot be honoured. Callers
 *           should reject the request up front rather than run a generation
 *           that gpt-image-2 will refuse after a full agent session.
 */
export function normalizeSize(size) {
  if (size == null || String(size).trim() === "") {
    return { value: "1024x1024", note: "", error: null };
  }
  const s = String(size).trim().toLowerCase();

  if (s === "auto") return { value: "auto", note: "", error: null };
  if (SIZE_SHORTCUTS[s]) return { value: SIZE_SHORTCUTS[s], note: "", error: null };

  const m = s.match(/^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/);
  if (!m) {
    return {
      value: null,
      note: "",
      error: `could not parse size "${size}". Use "auto", "1K"/"2K"/"4K", or "WIDTHxHEIGHT" (e.g. "1536x1024").`,
    };
  }

  const { step, maxEdge, maxRatio, minPixels, maxPixels } = SIZE_LIMITS;
  const reqW = Number(m[1]);
  const reqH = Number(m[2]);
  const w = Math.max(step, Math.round(reqW / step) * step);
  const h = Math.max(step, Math.round(reqH / step) * step);
  const note =
    w !== reqW || h !== reqH
      ? `rounded ${reqW}x${reqH} to ${w}x${h} (each edge must be a multiple of ${step})`
      : "";

  const problems = [];
  if (w > maxEdge || h > maxEdge) problems.push(`the longest edge may be at most ${maxEdge}px`);
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > maxRatio) problems.push(`the aspect ratio may be at most ${maxRatio}:1 (got ${ratio.toFixed(2)}:1)`);
  const pixels = w * h;
  if (pixels < minPixels) {
    problems.push(`too few pixels (${pixels.toLocaleString("en-US")} < ${minPixels.toLocaleString("en-US")}; try 1024x1024 or larger)`);
  }
  if (pixels > maxPixels) {
    problems.push(`too many pixels (${pixels.toLocaleString("en-US")} > ${maxPixels.toLocaleString("en-US")}; 3840x2160 is the largest)`);
  }

  if (problems.length) {
    return {
      value: null,
      note,
      error: `size ${w}x${h} is not supported by gpt-image-2: ${problems.join("; ")}.`,
    };
  }
  return { value: `${w}x${h}`, note, error: null };
}
