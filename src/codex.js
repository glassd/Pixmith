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
  // Tightly scripted so Codex reliably uses the built-in image_gen tool and
  // copies the result to an exact path, then echoes a parseable marker.
  return [
    "You are running non-interactively. Do not ask any questions; make reasonable assumptions and proceed.",
    "",
    "TASK: Use the $imagegen skill's built-in `image_gen` tool to generate exactly one raster image.",
    "",
    `IMAGE PROMPT: ${prompt}`,
    "",
    `SIZE: ${sizeValue === "auto" ? "auto (model decides)" : sizeValue}`,
    "",
    "REQUIREMENTS:",
    "- Use the built-in image_gen tool (gpt-image-2). Do NOT use the CLI fallback, do NOT ask about OPENAI_API_KEY, do NOT use transparency unless the image prompt explicitly asks for it.",
    "- Generate a single image (no variants).",
    `- After it is generated, copy the final PNG to EXACTLY this absolute destination path: ${targetPath}`,
    "- Create parent directories if needed. Overwrite the destination if it already exists.",
    "- Do not generate any other files or assets.",
    "",
    "OUTPUT CONTRACT: Your final message must be exactly one line and nothing else:",
    `SAVED:${targetPath}`,
    "If generation fails for any reason, your final message must be exactly one line starting with:",
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

/** Newest *.png under CODEX_HOME/generated_images created at/after `sinceMs`. */
async function newestGeneratedImage(sinceMs) {
  const root = path.join(config.codexHome, "generated_images");
  let best = null;
  let stack = [root];
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
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        if (st.mtimeMs + 2000 < sinceMs) continue; // small clock skew tolerance
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path: full, mtimeMs: st.mtimeMs };
        }
      }
    }
  }
  return best ? best.path : null;
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
  const startMs = Date.now();

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

  // 5. Locate the produced PNG, most-trusted source first.
  const codexHomeCopy = await newestGeneratedImage(startMs);
  let finalPath = null;

  if (fssync.existsSync(targetPath)) {
    finalPath = targetPath;
  } else if (marker && marker.ok && fssync.existsSync(marker.path)) {
    finalPath = marker.path;
  } else if (codexHomeCopy) {
    // Codex generated it but the copy step didn't land where we asked; copy it.
    try {
      await fs.copyFile(codexHomeCopy, targetPath);
      finalPath = targetPath;
    } catch {
      finalPath = codexHomeCopy;
    }
  }

  if (!finalPath) {
    throw new PixmithError(
      "no_output",
      `Codex exited with code ${code} but no PNG was produced. ${
        marker ? "" : "No SAVED marker was found in Codex's output. "
      }See detail for the tail of Codex's stderr.`,
      tail(stderr) || tail(stdout),
    );
  }

  const st = await fs.stat(finalPath);
  if (!st.size) {
    throw new PixmithError("no_output", `Produced file "${finalPath}" is empty.`);
  }

  return {
    path: path.resolve(finalPath),
    size: sizeValue,
    sizeNote,
    bytes: st.size,
    codexHomeCopy: codexHomeCopy ? path.resolve(codexHomeCopy) : null,
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
