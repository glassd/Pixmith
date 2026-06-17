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

function slugForFilename(prompt) {
  const base = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "image";
}

/**
 * A deterministic-ish but unique filename. We avoid Date.now/Math.random being
 * unavailable concerns by using high-resolution time + pid, which is always
 * available in Node.
 */
function uniqueStamp() {
  const hr = process.hrtime.bigint().toString(36);
  return `${hr}-${process.pid}`;
}

function buildPrompt(prompt, sizeValue, targetPath) {
  // The agent's ONLY job is to call image_gen once. Pixmith locates the saved
  // PNG itself (image_gen writes to $CODEX_HOME/generated_images), so we
  // explicitly forbid copying / shell / filesystem hunting — that agent work is
  // slow and non-deterministic (and on Windows the agent ends up scanning logs).
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

/** Parse a SAVED:/ERROR: marker out of arbitrary agent text. */
function parseMarker(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("SAVED:")) {
      return { ok: true, path: line.slice("SAVED:".length).trim() };
    }
    if (line.startsWith("ERROR:")) {
      return { ok: false, reason: line.slice("ERROR:".length).trim() };
    }
  }
  return null;
}

/**
 * List every *.png under CODEX_HOME/generated_images as a Map of
 * absolutePath -> mtimeMs. Used to snapshot before/after a run so we can
 * identify the file THIS run produced by set difference (robust, unlike an
 * mtime time-window which is flaky across filesystems/clocks and can match a
 * stale image from a previous run).
 */
async function listGeneratedPngs() {
  const root = path.join(config.codexHome, "generated_images");
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
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".png")) {
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

// PNG files always start with this 8-byte signature.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * True only if `filePath` is a real PNG (starts with the PNG magic bytes). This
 * guards against a non-image file — e.g. a log or text output accidentally
 * written with a .png name — being copied out and returned as the image.
 */
async function isPng(filePath) {
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
 * Recover a PNG from base64 embedded in text (e.g. Codex's log/output stream).
 * The image_gen result carries the image as base64, which always begins with
 * "iVBORw0KGgo" (the base64 of the PNG magic header). On some platforms the file
 * isn't written to disk and this base64 is the only copy of the image — so if no
 * real PNG file appears, we decode it from the captured output ourselves.
 * Returns the largest valid decoded PNG Buffer found, or null.
 */
function extractBase64Png(text) {
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

function detectAuthFailure(stderr, stdout) {
  const hay = `${stderr}\n${stdout}`.toLowerCase();
  return (
    hay.includes("not signed in") ||
    hay.includes("please sign in") ||
    hay.includes("run `codex login`") ||
    hay.includes("codex login") ||
    hay.includes("unauthorized") ||
    (hay.includes("auth") && hay.includes("login required"))
  );
}

/**
 * Core engine: drive `codex exec` to produce a PNG and return its absolute path.
 *
 * @param {object} args
 * @param {string} args.prompt   Required image description.
 * @param {string} [args.size]   "auto" | "1K"|"2K"|"4K" | "WIDTHxHEIGHT".
 * @param {string} [args.outputDir] Destination directory (defaults to config).
 * @param {(line:string)=>void} [args.onProgress] Optional stderr progress sink.
 * @returns {Promise<{path:string, size:string, sizeNote:string, bytes:number, codexHomeCopy:string|null}>}
 */
export async function generateImage({ prompt, size, outputDir, onProgress } = {}) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new PixmithError("bad_request", "`prompt` is required and must be a non-empty string.");
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
  const destDir = path.resolve(outputDir || config.defaultOutputDir);
  await fs.mkdir(destDir, { recursive: true });

  const { value: sizeValue, note: sizeNote } = normalizeSize(size);
  const filename = `${slugForFilename(prompt)}-${uniqueStamp()}.png`.replace(SAFE_NAME, "-");
  const targetPath = path.join(destDir, filename);

  // 3. Temp file for Codex's final message.
  const lastMsgPath = path.join(
    os.tmpdir(),
    `pixmith-last-${uniqueStamp()}.txt`,
  );

  const fullPrompt = buildPrompt(prompt.trim(), sizeValue, targetPath);

  // Snapshot existing generated images BEFORE the run, so we can identify the
  // file this run produces by set difference (not by a flaky mtime window).
  const beforeSnapshot = await listGeneratedPngs();

  // Sandbox vs. bypass. Codex's OS sandbox (Seatbelt/Landlock) is macOS/Linux
  // only; on Windows it has no equivalent and blocks the file-save, so we run
  // unsandboxed there (see config.bypassSandbox). When sandboxed, we grant write
  // access to the destination via --add-dir.
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

  // 4. Read Codex's final message (preferred source of truth).
  let lastMessage = "";
  try {
    lastMessage = await fs.readFile(lastMsgPath, "utf8");
  } catch {
    /* file may not exist on hard failure */
  } finally {
    fs.unlink(lastMsgPath).catch(() => {});
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
    throw new PixmithError(
      "generation_failed",
      `Codex reported a generation failure: ${marker.reason}`,
      tail(stderr),
    );
  }

  // 5. Locate the PNG THIS run produced via snapshot diff: the newest *.png in
  // generated_images that was NOT present before the run. This is what makes
  // each job return its own image (never a stale one from a previous job).
  const afterSnapshot = await listGeneratedPngs();
  const newPngs = [];
  for (const [p, mtime] of afterSnapshot) {
    if (!beforeSnapshot.has(p)) newPngs.push({ path: p, mtime });
  }
  newPngs.sort((a, b) => b.mtime - a.mtime);

  // Newest NEW file that is actually a PNG (skip anything that isn't a real
  // image, e.g. a log/text file that happens to carry a .png name).
  let sourcePng = null;
  for (const candidate of newPngs) {
    if (await isPng(candidate.path)) {
      sourcePng = candidate.path;
      break;
    }
  }

  let finalPath = null;

  if (sourcePng) {
    // Normal path: copy the new image file into the requested destination.
    try {
      await fs.copyFile(sourcePng, targetPath);
      finalPath = targetPath;
    } catch {
      finalPath = sourcePng; // fall back to returning the source path directly
    }
  } else {
    // No real PNG file was written (seen on platforms where image_gen returns
    // the image as base64 in its output rather than a file). Recover it by
    // decoding the base64 from Codex's captured output and writing real bytes.
    const recovered =
      extractBase64Png(lastMessage) ||
      extractBase64Png(stdout) ||
      extractBase64Png(stderr);
    if (recovered) {
      await fs.writeFile(targetPath, recovered);
      finalPath = targetPath;
    }
  }

  if (!finalPath) {
    throw new PixmithError(
      "no_output",
      `Codex exited with code ${code} but produced no valid PNG — none was written to ` +
        `${path.join(config.codexHome, "generated_images")} and no base64 image was found in its output. ` +
        "The generation may have been refused or failed.",
      tail(stderr) || tail(stdout),
    );
  }

  // Final guard: the file we return must be a non-empty, valid PNG (never a log).
  const st = await fs.stat(finalPath);
  if (!st.size || !(await isPng(finalPath))) {
    throw new PixmithError(
      "no_output",
      `The produced file "${finalPath}" is not a valid PNG image.`,
      tail(stderr),
    );
  }

  return {
    path: path.resolve(finalPath),
    size: sizeValue,
    sizeNote,
    bytes: st.size,
    codexHomeCopy: sourcePng ? path.resolve(sourcePng) : null,
  };
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
    const opts = { stdio: ["pipe", "pipe", "pipe"], env: process.env };
    if (needsShell) {
      opts.shell = true;
      command = winQuote(config.codexBin);
      spawnArgs = args.map(winQuote);
    }

    let child;
    try {
      child = spawn(command, spawnArgs, opts);
    } catch (err) {
      reject(
        new PixmithError("spawn_failed", `Failed to launch Codex: ${err.message}`),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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
