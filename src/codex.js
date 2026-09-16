import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

import { config, normalizeSize } from "./config.js";

/** Error with a `kind` tag so the MCP layer can produce a clear message. */
export class PixmithError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = "PixmithError";
    this.kind = kind;
    this.detail = detail;
  }
}

const SAFE_NAME = /[^a-z0-9._-]+/gi;

export function slugForFilename(prompt) {
  const base = String(prompt ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "image";
}

/** A unique filename stamp from high-resolution time + pid. */
function uniqueStamp() {
  const hr = process.hrtime.bigint().toString(36);
  return `${hr}-${process.pid}`;
}

export function buildPrompt(prompt, sizeValue) {
  // The agent's ONLY job is to call image_gen once. Pixmith locates the saved
  // PNG itself (image_gen writes to $CODEX_HOME/generated_images/<session>/),
  // so we explicitly forbid copying / shell / filesystem hunting — that agent
  // work is slow and non-deterministic.
  return [
    "You are running non-interactively. Do not ask any questions; proceed.",
    "",
    "TASK: Use the $imagegen skill's built-in `image_gen` tool to generate exactly ONE raster image.",
    "",
    `IMAGE PROMPT: ${prompt}`,
    "",
    `SIZE: ${sizeValue === "auto" ? "auto (model decides)" : sizeValue}`,
    "",
    "RULES:",
    "- Use the built-in image_gen tool (gpt-image-2). Do NOT use the CLI fallback, do NOT ask about OPENAI_API_KEY, do NOT use transparency unless the image prompt explicitly asks for it.",
    "- Generate exactly one image (no variants).",
    "- Do NOT copy, move, rename, or post-process the file. Do NOT run shell commands. Do NOT search the filesystem. Saving and locating the file is handled externally — your only job is to call image_gen once.",
    "",
    "OUTPUT CONTRACT: When the image has been generated, your final message must be exactly the single word:",
    "DONE",
    "If you cannot generate it, your final message must instead start with:",
    "ERROR: <short reason>",
  ].join("\n");
}

/**
 * Parse the agent's final-message contract. Returns { ok: true } for DONE,
 * { ok: false, reason } for an ERROR: line, or null when neither is present.
 * Only the LAST non-empty line is inspected, so an "ERROR:" that merely
 * appears inside the image prompt (echoed back by Codex) is never mistaken
 * for a failure report.
 */
export function parseMarker(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  if (last === "DONE") return { ok: true };
  if (last.startsWith("ERROR:")) return { ok: false, reason: last.slice("ERROR:".length).trim() };
  return null;
}

/**
 * Extract the Codex session id from its startup banner ("session id: <uuid>").
 * Codex names both the generated_images/<id>/ directory and the rollout log
 * after this id, which lets each Pixmith job find exactly its own output —
 * even when several generations run at once.
 */
export function parseSessionId(text) {
  if (!text) return null;
  const m = text.match(/session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Recursively list files under `root` matching `ext` as a Map of absolutePath -> mtimeMs. */
async function listFiles(root, ext) {
  const out = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(ext)) {
        try {
          out.set(full, (await fs.stat(full)).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}

/** Every *.png under CODEX_HOME/generated_images (optionally just one session's dir). */
export function listGeneratedPngs(sessionId = null) {
  const root = sessionId
    ? path.join(config.codexHome, "generated_images", sessionId)
    : path.join(config.codexHome, "generated_images");
  return listFiles(root, ".png");
}

/** Every rollout *.jsonl under CODEX_HOME/sessions. */
export function listRolloutLogs() {
  return listFiles(path.join(config.codexHome, "sessions"), ".jsonl");
}

// PNG files always start with this 8-byte signature.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * True only if `filePath` is a real PNG (starts with the PNG magic bytes). This
 * guards against a non-image file — e.g. a log or text output accidentally
 * written with a .png name — being copied out and returned as the image.
 */
export async function isPng(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    return bytesRead === 8 && buf.equals(PNG_MAGIC);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Read the actual pixel dimensions from a PNG's IHDR chunk, which always
 * directly follows the 8-byte signature: 4-byte length, "IHDR", then width and
 * height as big-endian uint32. gpt-image-2 does not always honour the requested
 * size exactly, so we report what was really produced. Returns null when the
 * file is not a PNG or is truncated.
 */
export async function readPngDimensions(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Recover a PNG from base64 embedded in text (e.g. Codex's log/output stream).
 * The image_gen result carries the image as base64, which always begins with
 * "iVBORw0KGgo" (the base64 of the PNG magic header). On some platforms the file
 * isn't written to disk and this base64 is the only copy of the image — so if no
 * real PNG file appears, we decode it from the captured output ourselves.
 * Returns the largest valid decoded PNG Buffer found, or null.
 */
export function extractBase64Png(text) {
  if (!text) return null;
  const marker = "iVBORw0KGgo";
  let best = null;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(marker, from);
    if (idx === -1) break;
    // base64 may be split across lines in a log; allow interleaved whitespace.
    const m = text.slice(idx).match(/^[A-Za-z0-9+/=\r\n\t ]+/);
    if (m) {
      const b64 = m[0].replace(/[^A-Za-z0-9+/=]/g, "");
      try {
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 1024 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
          if (!best || buf.length > best.length) best = buf;
        }
      } catch {
        /* not valid base64; keep scanning */
      }
    }
    from = idx + marker.length;
  }
  return best;
}

/**
 * Recover the image from this run's Codex session rollout log. Each `codex exec`
 * writes the conversation — including the image_gen result's base64 image — to a
 * rollout *.jsonl under CODEX_HOME/sessions whose filename carries the session
 * id. On platforms where image_gen doesn't write a PNG file (e.g. Windows) this
 * log is where the image lives. We prefer the log named after our session id
 * and fall back to any log that is new or changed since the pre-run snapshot.
 * Returns a PNG Buffer or null.
 */
export async function recoverFromRolloutLogs(rolloutsBefore, sessionId = null) {
  const after = await listRolloutLogs();
  const candidates = [];
  for (const [p, mtime] of after) {
    const ours = sessionId && path.basename(p).toLowerCase().includes(sessionId);
    const fresh = !rolloutsBefore.has(p) || rolloutsBefore.get(p) !== mtime;
    if (ours || (!sessionId && fresh)) candidates.push({ path: p, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const r of candidates) {
    let txt;
    try {
      txt = await fs.readFile(r.path, "utf8");
    } catch {
      continue;
    }
    const buf = extractBase64Png(txt);
    if (buf) return buf;
  }
  return null;
}

const AUTH_PHRASES = [
  "not signed in",
  "not logged in",
  "please sign in",
  "please log in",
  "codex login",
  "login required",
  "401 unauthorized",
  "invalid api key",
  "authentication failed",
];

/**
 * Heuristic: does Codex's output look like an auth failure? Only consulted
 * AFTER we've established that no image was produced, so a stray phrase inside
 * a successful run can never turn it into an error.
 */
export function detectAuthFailure(stderr, stdout) {
  const hay = `${stderr}\n${stdout}`.toLowerCase();
  return AUTH_PHRASES.some((p) => hay.includes(p));
}

/**
 * Core engine: drive `codex exec` to produce a PNG and return its absolute path.
 *
 * @param {object} args
 * @param {string} args.prompt   Required image description.
 * @param {string} [args.size]   "auto" | "1K"|"2K"|"4K" | "WIDTHxHEIGHT".
 * @param {string} [args.outputDir] Absolute destination directory (defaults to config).
 * @param {(line:string)=>void} [args.onProgress] Optional stderr progress sink.
 * @returns {Promise<{path:string, size:string, requestedSize:string, sizeNote:string, width:number|null, height:number|null, bytes:number, codexHomeCopy:string|null, sessionId:string|null}>}
 *   `size` is the actual "WIDTHxHEIGHT" read from the PNG (falls back to the
 *   requested size if the header can't be read); `requestedSize` is what was
 *   asked of Codex.
 */
export async function generateImage({ prompt, size, outputDir, onProgress } = {}) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new PixmithError("bad_request", "`prompt` is required and must be a non-empty string.");
  }

  const { value: sizeValue, note: sizeNote, error: sizeError } = normalizeSize(size);
  if (sizeError) throw new PixmithError("bad_request", `Invalid \`size\`: ${sizeError}`);

  if (outputDir != null) {
    if (typeof outputDir !== "string" || !outputDir.trim()) {
      throw new PixmithError("bad_request", "`output_dir` must be a non-empty string when provided.");
    }
    if (!path.isAbsolute(outputDir.trim())) {
      throw new PixmithError(
        "bad_request",
        `\`output_dir\` must be an absolute path (got "${outputDir}"). Relative paths would resolve against the MCP server's working directory, which the client controls.`,
      );
    }
  }

  // 1. Binary present? Only verify when CODEX_BIN looks like a filesystem path.
  // A bare command name (e.g. "codex") is resolved on PATH by the OS, so we let
  // spawn try it and surface an ENOENT as a binary_missing error below.
  const looksLikePath =
    path.isAbsolute(config.codexBin) ||
    config.codexBin.includes("/") ||
    config.codexBin.includes("\\");
  if (looksLikePath && !fssync.existsSync(config.codexBin)) {
    throw new PixmithError(
      "binary_missing",
      `Codex binary not found at "${config.codexBin}". Install the Codex CLI (or the Codex desktop app), or set the CODEX_BIN environment variable to its absolute path.\n\nLooked in:\n  ${config.codexCandidates.join("\n  ")}`,
    );
  }

  // 2. Resolve and prepare destination.
  const destDir = path.resolve(outputDir ? outputDir.trim() : config.defaultOutputDir);
  await fs.mkdir(destDir, { recursive: true });

  const filename = `${slugForFilename(prompt)}-${uniqueStamp()}.png`.replace(SAFE_NAME, "-");
  const targetPath = path.join(destDir, filename);

  // 3. Temp file for Codex's final message.
  const lastMsgPath = path.join(os.tmpdir(), `pixmith-last-${uniqueStamp()}.txt`);

  const fullPrompt = buildPrompt(prompt.trim(), sizeValue);

  // Snapshot generated images and rollout logs BEFORE the run. These are only
  // the fallback when Codex's session id can't be parsed from its output; the
  // primary lookup is generated_images/<session id>/, which is exact.
  const beforeSnapshot = await listGeneratedPngs();
  const rolloutsBefore = await listRolloutLogs();

  // Sandbox vs. bypass. Codex's OS sandbox (Seatbelt/Landlock) is macOS/Linux
  // only; on Windows it has no equivalent and blocks the file-save, so we run
  // unsandboxed there (see config.bypassSandbox).
  const sandboxArgs = config.bypassSandbox
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["-s", config.sandbox, "--add-dir", destDir];

  // Note: the prompt is passed via stdin (the "-" sentinel), NOT as a CLI arg.
  // It's a large multi-line string and embedding it in an argv that may pass
  // through a Windows shell (.cmd shims) is fragile; stdin avoids all quoting.
  const codexArgs = [
    "exec",
    "--skip-git-repo-check",
    ...sandboxArgs,
    "-C",
    destDir,
    "--output-last-message",
    lastMsgPath,
    "-", // read the prompt from stdin
  ];

  const { stdout, stderr, code, timedOut } = await runCodex(codexArgs, fullPrompt, onProgress);

  // 4. Read Codex's final message.
  let lastMessage = "";
  try {
    lastMessage = await fs.readFile(lastMsgPath, "utf8");
  } catch {
    /* file may not exist on hard failure */
  } finally {
    fs.unlink(lastMsgPath).catch(() => {});
  }

  const sessionId = parseSessionId(stderr) || parseSessionId(stdout);

  // 5. Locate the PNG THIS run produced. Preferred: the session-scoped
  // directory generated_images/<session id>/, which cannot contain another
  // job's output. Fallback (no session id parsed): newest PNG that was not
  // present in the pre-run snapshot.
  let candidates = [];
  if (sessionId) {
    for (const [p, mtime] of await listGeneratedPngs(sessionId)) candidates.push({ path: p, mtime });
  } else {
    for (const [p, mtime] of await listGeneratedPngs()) {
      if (!beforeSnapshot.has(p)) candidates.push({ path: p, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  let sourcePng = null;
  for (const c of candidates) {
    if (await isPng(c.path)) {
      sourcePng = c.path;
      break;
    }
  }

  let finalPath = null;
  if (sourcePng) {
    try {
      await fs.copyFile(sourcePng, targetPath);
      finalPath = targetPath;
    } catch {
      finalPath = sourcePng; // fall back to returning the source path directly
    }
  } else {
    // No PNG file was written (seen where image_gen returns base64 only, e.g.
    // Windows). Recover it from Codex's captured output, then from this run's
    // session rollout log.
    const recovered =
      extractBase64Png(lastMessage) ||
      extractBase64Png(stdout) ||
      extractBase64Png(stderr) ||
      (await recoverFromRolloutLogs(rolloutsBefore, sessionId));
    if (recovered) {
      await fs.writeFile(targetPath, recovered);
      finalPath = targetPath;
    }
  }

  // 6. A produced image always wins. Only when nothing was produced do we try
  // to classify WHY, so stray phrases in the echoed prompt can't turn a
  // successful run into an error.
  if (finalPath) {
    const st = await fs.stat(finalPath);
    if (st.size && (await isPng(finalPath))) {
      const dims = await readPngDimensions(finalPath);
      return {
        path: path.resolve(finalPath),
        size: dims ? `${dims.width}x${dims.height}` : sizeValue,
        requestedSize: sizeValue,
        sizeNote,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        bytes: st.size,
        codexHomeCopy: sourcePng ? path.resolve(sourcePng) : null,
        sessionId,
      };
    }
    throw new PixmithError("no_output", `The produced file "${finalPath}" is not a valid PNG image.`, tail(stderr));
  }

  if (timedOut) {
    throw new PixmithError(
      "timeout",
      `Codex did not finish within ${Math.round(config.timeoutMs / 1000)}s. The image may be too large or the service is slow. Increase PIXMITH_TIMEOUT_MS and retry.`,
      tail(stderr),
    );
  }

  if (detectAuthFailure(stderr, stdout)) {
    throw new PixmithError(
      "not_signed_in",
      "Codex is not signed in. Sign in to Codex with your ChatGPT account (open the Codex app, or run `codex login`), then retry.",
      tail(stderr),
    );
  }

  const marker = parseMarker(lastMessage) || parseMarker(stdout);
  if (marker && marker.ok === false) {
    throw new PixmithError("generation_failed", `Codex reported a generation failure: ${marker.reason}`, tail(stderr));
  }

  throw new PixmithError(
    "no_output",
    `Codex exited with code ${code} but produced no valid PNG — none was written to ` +
      `${path.join(config.codexHome, "generated_images", sessionId || "<session>")}, and no base64 image was found in its output or ` +
      `session logs (${path.join(config.codexHome, "sessions")}). The generation may have been refused or failed.`,
    tail(stderr) || tail(stdout),
  );
}

function tail(s, n = 1200) {
  if (!s) return "";
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Quote an argument for a Windows shell (cmd.exe) when spaces/quotes are present. */
function winQuote(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Kill the Codex process and everything it spawned. On Windows a `.cmd` shim
 * runs under cmd.exe, so killing `child` alone would orphan the real codex
 * process; `taskkill /T` walks the tree.
 */
function killTree(child) {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Spawn codex, feed the prompt via stdin, stream stderr to onProgress, enforce
 * a timeout. Cross-platform: on Windows, `.cmd`/`.bat` shims (e.g. an npm-global
 * `codex.cmd`) cannot be spawned directly, so we run them through a shell and
 * quote the arguments. A native `codex.exe` (or any non-Windows binary) is
 * spawned directly with no shell.
 */
function runCodex(args, promptStdin, onProgress) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const needsShell = isWindows && !/\.exe$/i.test(config.codexBin);

    let command = config.codexBin;
    let spawnArgs = args;
    const opts = { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true };
    if (needsShell) {
      opts.shell = true;
      command = winQuote(config.codexBin);
      spawnArgs = args.map(winQuote);
    }

    let child;
    try {
      child = spawn(command, spawnArgs, opts);
    } catch (err) {
      reject(new PixmithError("spawn_failed", `Failed to launch Codex: ${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, config.timeoutMs);

    // Feed the prompt to Codex via stdin, then close it.
    if (child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if codex exits early
      child.stdin.write(promptStdin);
      child.stdin.end();
    }

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (onProgress) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onProgress(line);
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT means the command (often a bare `codex` on PATH) wasn't found.
      const kind = err.code === "ENOENT" ? "binary_missing" : "spawn_failed";
      const msg =
        err.code === "ENOENT"
          ? `Could not find the Codex binary ("${config.codexBin}"). Install the Codex CLI and ensure it's on your PATH, or set CODEX_BIN to its absolute path.`
          : `Codex process error: ${err.message}`;
      reject(new PixmithError(kind, msg));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
