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

const HOME = os.homedir();

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

/** Resolve the Codex binary: explicit env override, else first existing candidate, else PATH. */
function resolveCodexBin() {
  const override = envStr("CODEX_BIN", null);
  if (override) return override;
  for (const candidate of codexCandidates()) {
    try {
      if (path.isAbsolute(candidate) && fssync.existsSync(candidate)) return candidate;
    } catch {
      /* ignore and keep trying */
    }
  }
  return "codex"; // rely on PATH
}

export const config = {
  // Path to the Codex binary, or a bare command resolved on PATH.
  codexBin: resolveCodexBin(),
  // Every candidate we considered — used to build a helpful "not found" error.
  codexCandidates: codexCandidates(),

  // Sandbox policy passed to `codex exec` (when the OS sandbox is in use).
  sandbox: envStr("PIXMITH_SANDBOX", "workspace-write"),

  // Bypass Codex's OS sandbox entirely. Codex sandboxing is implemented with
  // macOS Seatbelt / Linux Landlock and has no Windows equivalent, so on Windows
  // the sandboxed file-save is blocked. Default: bypass on Windows, sandbox
  // elsewhere. Override with PIXMITH_BYPASS_SANDBOX=true|false.
  bypassSandbox: (() => {
    const raw = process.env.PIXMITH_BYPASS_SANDBOX;
    if (raw != null && raw.trim() !== "") return raw.trim().toLowerCase() === "true";
    return process.platform === "win32";
  })(),

  // Where images land by default when the caller does not pass output_dir.
  // fileURLToPath keeps this correct on Windows (no leading-slash drive bug).
  defaultOutputDir:
    process.env.PIXMITH_OUTPUT_DIR ||
    path.resolve(fileURLToPath(new URL("../images", import.meta.url))),

  // CODEX_HOME holds generated_images/<session>/ig_*.png as a backup location.
  codexHome: process.env.CODEX_HOME || path.join(HOME, ".codex"),

  // Hard timeout for a single generation, in milliseconds.
  timeoutMs: envInt("PIXMITH_TIMEOUT_MS", 5 * 60 * 1000),

  // Whether to inline the PNG as MCP image content (base64), and the size cap.
  returnImage: (process.env.PIXMITH_RETURN_IMAGE || "true").toLowerCase() !== "false",
  maxInlineBytes: envInt("PIXMITH_MAX_INLINE_BYTES", 6 * 1024 * 1024),
};

/**
 * Normalize a requested size into something the imagegen skill understands.
 * Accepts: "auto", "1K"/"2K"/"4K" shortcuts, or explicit "WIDTHxHEIGHT".
 * Returns { value, note } where value is what we feed Codex and note explains
 * any coercion (empty when the input was used verbatim).
 */
export function normalizeSize(size) {
  if (size == null || String(size).trim() === "") {
    return { value: "1024x1024", note: "" };
  }
  const s = String(size).trim().toLowerCase();

  if (s === "auto") return { value: "auto", note: "" };

  const shortcuts = {
    "1k": "1024x1024",
    "2k": "2048x2048",
    "4k": "3840x2160",
  };
  if (shortcuts[s]) return { value: shortcuts[s], note: "" };

  const m = s.match(/^(\d{2,4})\s*[x×]\s*(\d{2,4})$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    // gpt-image-2 constraints: each edge multiple of 16, max edge 3840.
    if (w >= 256 && h >= 256 && w <= 3840 && h <= 3840) {
      return { value: `${w}x${h}`, note: "" };
    }
    return {
      value: "1024x1024",
      note: `requested size ${w}x${h} is out of range; used 1024x1024`,
    };
  }

  return {
    value: "1024x1024",
    note: `could not parse size "${size}"; used 1024x1024`,
  };
}
