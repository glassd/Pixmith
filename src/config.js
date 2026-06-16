import os from "node:os";
import path from "node:path";

/**
 * Central configuration for Pixmith, resolved from environment variables with
 * sensible defaults. Nothing here reads or exposes any Codex auth tokens.
 */

const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  // Absolute path to the Codex binary (bundled with the Codex desktop app).
  codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,

  // Where images land by default when the caller does not pass output_dir.
  defaultOutputDir:
    process.env.PIXMITH_OUTPUT_DIR ||
    path.resolve(new URL("../images", import.meta.url).pathname),

  // CODEX_HOME holds generated_images/<session>/ig_*.png as a backup location.
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),

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
