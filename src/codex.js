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

/**
 * Build the scripted prompt for one `codex exec` run.
 *
 * @param {string} prompt     The image description, or the edit instruction.
 * @param {string} sizeValue  A normalized size ("auto" or "WIDTHxHEIGHT").
 * @param {object} [opts]
 * @param {"generate"|"edit"} [opts.mode]  "edit" treats attached Image 1 as the edit target.
 * @param {number} [opts.imageCount]       How many images are attached via `codex exec -i`.
 * @param {string} [opts.promptFile]       File holding the ready-made image_gen prompt (see fastPathPrompt).
 */
export function buildPrompt(prompt, sizeValue, { mode = "generate", imageCount = 0, promptFile = null } = {}) {
  // The agent's ONLY job is to call image_gen once. Pixmith locates the saved
  // PNG itself (image_gen writes to $CODEX_HOME/generated_images/<session>/),
  // so we explicitly forbid copying / shell / filesystem hunting — that agent
  // work is slow and non-deterministic.
  const editing = mode === "edit";
  const lines = [
    "You are running non-interactively. Do not ask any questions; proceed.",
    "",
    editing
      ? "TASK: Use the $imagegen skill's built-in `image_gen` tool to EDIT the attached image, producing exactly ONE raster image."
      : "TASK: Use the $imagegen skill's built-in `image_gen` tool to generate exactly ONE raster image.",
    "",
  ];

  if (imageCount > 0) {
    lines.push(`INPUT IMAGES: ${imageCount} image${imageCount === 1 ? " is" : "s are"} attached to this message and already visible to you.`);
    for (let i = 1; i <= imageCount; i += 1) {
      const role = editing && i === 1 ? "edit target" : "reference (style / composition / subject)";
      lines.push(`- Image ${i}: ${role}`);
    }
    lines.push("");
  }

  if (promptFile) {
    // The agent emits its tool call token by token (~35 tokens/s), so retyping
    // a long image prompt costs 10s or more before rendering even starts.
    // Loading the prompt from a file keeps the tool call short and constant.
    lines.push(
      "FAST PATH — do this first. The complete image_gen prompt (description plus size) is already saved in a file, so you do not need to retype it.",
      "Make exactly this ONE code-execution tool call, copied character for character, with no message before it:",
      "",
      `const r = await tools.exec_command({cmd: "cat '${promptFile}'", max_output_tokens: 8000});`,
      "const result = await tools.image_gen__imagegen({prompt: r.output.trim()});",
      "generatedImage(result);",
      "",
      "Only if that call cannot run because those tools do not exist, fall back to calling image_gen yourself using the IMAGE PROMPT and SIZE below.",
      "",
    );
  }

  lines.push(
    `${editing ? "EDIT INSTRUCTION" : "IMAGE PROMPT"}: ${prompt}`,
    "",
    `SIZE: ${sizeValue === "auto" ? (editing ? "auto (keep the edit target's aspect ratio)" : "auto (model decides)") : sizeValue}`,
    "",
    "RULES:",
    "- Use the built-in image_gen tool (gpt-image-2). Do NOT use the CLI fallback, do NOT ask about OPENAI_API_KEY, do NOT use transparency unless the image prompt explicitly asks for it.",
    "- Generate exactly one image (no variants).",
    "- Call image_gen IMMEDIATELY as your first action. Do not write any message before the tool call.",
    `- Pass the ${editing ? "edit instruction" : "image prompt"} to image_gen exactly as written above. Do not rewrite, expand or embellish it; add only the size.`,
  );
  if (editing) {
    lines.push(
      "- This is an EDIT of Image 1: change only what the edit instruction asks for and keep everything else (subject identity, composition, colours, text) unchanged.",
    );
  }
  if (imageCount > 0) {
    lines.push("- The attached images are already in the conversation. Do NOT call view_image or read them from disk.");
  }
  lines.push(
    "- Do NOT copy, move, rename, or post-process the file. Do NOT run shell commands. Do NOT search the filesystem. Saving and locating the file is handled externally — your only job is to call image_gen once.",
    "",
    "OUTPUT CONTRACT: When the image has been generated, your final message must be exactly the single word:",
    "DONE",
    "If you cannot generate it, your final message must instead start with:",
    "ERROR: <short reason>",
  );
  return lines.join("\n");
}

/** The text written to the fast-path prompt file: exactly what image_gen should receive. */
export function fastPathPrompt(prompt, sizeValue) {
  const size = sizeValue === "auto" ? "" : ` The image must be ${sizeValue} pixels.`;
  return `Generate exactly ONE raster image.${size} Opaque background unless the description asks for transparency.\n\n${prompt}\n`;
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

// Every PNG ends with this 12-byte IEND chunk (zero length, "IEND", its CRC).
const PNG_TRAILER = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * True when `filePath` is a PNG that has been written out in full: it starts
 * with the PNG signature and ends with the IEND chunk. Used to pick up Codex's
 * image the moment it is on disk without ever grabbing a half-written file.
 */
export async function isCompletePng(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const { size } = await fh.stat();
    if (size < PNG_MAGIC.length + PNG_TRAILER.length) return false;
    const head = Buffer.alloc(PNG_MAGIC.length);
    const tailBuf = Buffer.alloc(PNG_TRAILER.length);
    await fh.read(head, 0, head.length, 0);
    await fh.read(tailBuf, 0, tailBuf.length, size - tailBuf.length);
    return head.equals(PNG_MAGIC) && tailBuf.equals(PNG_TRAILER);
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

/** Human-readable labels for the stages a job moves through. */
export const STAGE_LABELS = Object.freeze({
  starting: "Starting Codex",
  session_started: "Codex session started",
  rendering: "Rendering the image",
  finishing: "Codex finished, collecting the image",
  saving: "Saving the image",
});

/**
 * Interpret one line of `codex exec --json` output (JSONL events). Returns null
 * for anything that is not a recognisable event, so a Codex build that prints
 * plain text instead simply yields no stage updates. Shape:
 *   { type, sessionId?, stage?, agentText?, error? }
 * Parsing is deliberately loose — the event schema has changed between Codex
 * releases, and an unknown event must never fail a generation.
 */
export function parseCodexEvent(line) {
  const t = String(line ?? "").trim();
  if (!t.startsWith("{")) return null;
  let ev;
  try {
    ev = JSON.parse(t);
  } catch {
    return null;
  }
  if (!ev || typeof ev.type !== "string") return null;
  const out = { type: ev.type };

  if (ev.type === "thread.started" || ev.type === "session.created") {
    const id = ev.thread_id || ev.session_id;
    if (typeof id === "string" && id) out.sessionId = id.toLowerCase();
    out.stage = "session_started";
  } else if (ev.type === "turn.started") {
    out.stage = "session_started";
  } else if (ev.type.startsWith("item.")) {
    const item = ev.item && typeof ev.item === "object" ? ev.item : {};
    if (item.type === "agent_message" && typeof item.text === "string" && ev.type === "item.completed") {
      out.agentText = item.text;
      // The closing DONE / ERROR message means the image_gen call is over.
      out.stage = parseMarker(item.text) ? "finishing" : "rendering";
    } else if (item.type === "error" && typeof item.message === "string") {
      out.error = item.message;
    } else {
      out.stage = "rendering";
    }
  } else if (ev.type === "turn.completed") {
    out.stage = "finishing";
  } else if (ev.type === "turn.failed") {
    out.error = String(ev.error?.message || ev.message || "the Codex turn failed");
  } else if (ev.type === "error") {
    out.error = String(ev.message || ev.error?.message || "unknown Codex error");
  }
  return out;
}

const IMAGE_SIGNATURES = [
  { type: "png", test: (b) => b.subarray(0, 8).equals(PNG_MAGIC) },
  { type: "jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "webp", test: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { type: "gif", test: (b) => b.toString("ascii", 0, 4) === "GIF8" },
];

/** Sniff an image file's real type from its magic bytes: "png" | "jpeg" | "webp" | "gif" | null. */
export async function detectImageType(filePath) {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead < 12) return null;
    return IMAGE_SIGNATURES.find((sig) => sig.test(buf))?.type ?? null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Validate the input images for an edit / reference request and return their
 * resolved absolute paths. Everything is checked up front so a bad path fails
 * in milliseconds instead of after a Codex session.
 */
export async function validateInputImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) {
    throw new PixmithError("bad_request", "Input images must be given as an array of absolute file paths.");
  }
  if (images.length > MAX_INPUT_IMAGES) {
    throw new PixmithError("bad_request", `At most ${MAX_INPUT_IMAGES} input images are supported (got ${images.length}).`);
  }
  const out = [];
  for (const raw of images) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new PixmithError("bad_request", "Each input image must be a non-empty absolute file path.");
    }
    const p = raw.trim();
    if (!path.isAbsolute(p)) {
      throw new PixmithError("bad_request", `Input image paths must be absolute (got "${raw}").`);
    }
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      throw new PixmithError("bad_request", `Input image not found: ${p}`);
    }
    if (!st.isFile()) throw new PixmithError("bad_request", `Input image is not a file: ${p}`);
    if (st.size > MAX_INPUT_IMAGE_BYTES) {
      throw new PixmithError(
        "bad_request",
        `Input image is too large (${st.size} bytes; the limit is ${MAX_INPUT_IMAGE_BYTES}): ${p}`,
      );
    }
    if (!(await detectImageType(p))) {
      throw new PixmithError("bad_request", `Input image is not a PNG, JPEG, WebP or GIF file: ${p}`);
    }
    out.push(path.resolve(p));
  }
  return out;
}

const USAGE_LIMIT_PHRASES = ["usage limit", "rate limit", "quota exceeded", "too many requests", "try again in"];

/** Heuristic: did Codex stop because the ChatGPT plan's limit was hit? Only consulted when no image was produced. */
export function detectUsageLimit(...texts) {
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  return USAGE_LIMIT_PHRASES.some((p) => hay.includes(p));
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
 * @param {string[]} [args.images] Absolute paths of input images, attached to the Codex prompt.
 * @param {"generate"|"edit"} [args.mode] "edit" treats images[0] as the edit target (and defaults size to "auto").
 * @param {AbortSignal} [args.signal] Abort to cancel: the Codex process tree is killed and a "cancelled" error is thrown.
 * @param {(stage:string)=>void} [args.onStage] Called as the run moves through STAGE_LABELS keys.
 * @param {(line:string)=>void} [args.onProgress] Optional stderr progress sink.
 * @returns {Promise<{path:string, size:string, requestedSize:string, sizeNote:string, width:number|null, height:number|null, bytes:number, codexHomeCopy:string|null, sessionId:string|null, mode:string, inputImages:string[], durationMs:number}>}
 *   `size` is the actual "WIDTHxHEIGHT" read from the PNG (falls back to the
 *   requested size if the header can't be read); `requestedSize` is what was
 *   asked of Codex.
 */
export async function generateImage({ prompt, size, outputDir, images, mode = "generate", signal, onStage, onProgress } = {}) {
  const startedAt = Date.now();
  if (mode !== "generate" && mode !== "edit") {
    throw new PixmithError("bad_request", `Unknown mode "${mode}" (expected "generate" or "edit").`);
  }
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new PixmithError("bad_request", "`prompt` is required and must be a non-empty string.");
  }

  // An edit keeps the source's aspect ratio unless the caller asks otherwise.
  const requested = mode === "edit" && (size == null || String(size).trim() === "") ? "auto" : size;
  const { value: sizeValue, note: sizeNote, error: sizeError } = normalizeSize(requested);
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

  const inputImages = await validateInputImages(images);
  if (mode === "edit" && inputImages.length === 0) {
    throw new PixmithError("bad_request", "Editing needs the image to edit: pass its absolute path.");
  }
  if (signal?.aborted) throw new PixmithError("cancelled", "The job was cancelled before it started.");

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

  // Fast path (plain generations only): hand the agent the prompt in a file.
  // Edits keep the normal path — there the agent's own rewrite, which spells
  // out what must stay unchanged, is worth its few seconds.
  let promptFile = null;
  if (config.fastPrompt && mode === "generate" && inputImages.length === 0) {
    promptFile = path.join(os.tmpdir(), `pixmith-prompt-${uniqueStamp()}.txt`);
    if (promptFile.includes("'")) {
      promptFile = null; // would break the shell quoting in the scripted call
    } else {
      await fs.writeFile(promptFile, fastPathPrompt(prompt.trim(), sizeValue));
    }
  }

  const fullPrompt = buildPrompt(prompt.trim(), sizeValue, { mode, imageCount: inputImages.length, promptFile });

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
  // `-i` is variadic, so each image gets its own flag and the list is always
  // followed by another option — never by the bare "-" prompt sentinel.
  const imageArgs = inputImages.flatMap((p) => ["-i", p]);

  // `--json` turns stdout into JSONL events: the session id arrives as a
  // structured field and each event marks a stage we can report as progress.
  // Optional overrides for the agent that wraps the image_gen call. The wrapper
  // only copies the prompt into one tool call, so a faster model is enough.
  const modelArgs = [];
  if (config.codexModel) modelArgs.push("-m", config.codexModel);
  if (config.codexEffort) modelArgs.push("-c", `model_reasoning_effort="${config.codexEffort}"`);

  const codexArgs = [
    "exec",
    "--json",
    ...modelArgs,
    "--skip-git-repo-check",
    ...imageArgs,
    ...sandboxArgs,
    "-C",
    destDir,
    "--output-last-message",
    lastMsgPath,
    "-", // read the prompt from stdin
  ];

  let stage = null;
  const setStage = (next) => {
    if (!next || next === stage) return;
    stage = next;
    if (onStage) onStage(next);
  };
  setStage("starting");

  // Early exit: image_gen writes the PNG into this session's folder as soon as
  // the render completes. After that Codex would still upload the image back to
  // the model and wait for it to say DONE — several seconds (and tokens) that
  // add nothing, so once a complete PNG is on disk we stop Codex and carry on.
  const imageReady = async (sid) => {
    if (!config.earlyExit || !sid) return false;
    for (const p of (await listGeneratedPngs(sid)).keys()) {
      if (await isCompletePng(p)) return true;
    }
    return false;
  };
  const runOpts = { onProgress, signal, onEvent: (ev) => setStage(ev.stage), until: imageReady };
  let run = await runCodex(codexArgs, fullPrompt, runOpts);
  // A Codex build without `--json` rejects the flag straight away. Run again
  // without it: stage updates are lost, but the banner/snapshot lookups below
  // still find the image.
  if (rejectedJsonFlag(run)) {
    run = await runCodex(codexArgs.filter((a) => a !== "--json"), fullPrompt, runOpts);
  }
  const { stdout, stderr, code, timedOut, aborted, agentText, eventErrors } = run;

  if (promptFile) fs.unlink(promptFile).catch(() => {});

  if (aborted) {
    fs.unlink(lastMsgPath).catch(() => {});
    throw new PixmithError("cancelled", "The job was cancelled; the Codex session was stopped.");
  }
  setStage("saving");

  // 4. Read Codex's final message.
  let lastMessage = "";
  try {
    lastMessage = await fs.readFile(lastMsgPath, "utf8");
  } catch {
    /* file may not exist on hard failure */
  } finally {
    fs.unlink(lastMsgPath).catch(() => {});
  }

  const sessionId = run.sessionId || parseSessionId(stderr) || parseSessionId(stdout);

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
      extractBase64Png(agentText) ||
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
        mode,
        inputImages,
        stoppedEarly: Boolean(run.stoppedEarly),
        durationMs: Date.now() - startedAt,
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

  const reported = eventErrors.join("\n");
  if (detectUsageLimit(reported, stderr)) {
    throw new PixmithError(
      "usage_limit",
      "Codex reports that your ChatGPT plan's usage limit was reached. Wait for the limit to reset, then retry.",
      tail(reported || stderr),
    );
  }

  const marker = parseMarker(lastMessage) || parseMarker(agentText) || parseMarker(stdout);
  if (marker && marker.ok === false) {
    throw new PixmithError("generation_failed", `Codex reported a generation failure: ${marker.reason}`, tail(stderr));
  }
  if (reported) {
    throw new PixmithError("generation_failed", `Codex reported an error: ${tail(reported, 400)}`, tail(stderr));
  }

  throw new PixmithError(
    "no_output",
    `Codex exited with code ${code} but produced no valid PNG — none was written to ` +
      `${path.join(config.codexHome, "generated_images", sessionId || "<session>")}, and no base64 image was found in its output or ` +
      `session logs (${path.join(config.codexHome, "sessions")}). The generation may have been refused or failed.`,
    tail(stderr) || tail(stdout),
  );
}

/** Did this Codex build refuse the `--json` flag (an argument-parsing failure, before any session started)? */
export function rejectedJsonFlag({ code, stderr, sessionId, aborted, timedOut }) {
  if (!code || sessionId || aborted || timedOut) return false;
  return /(unexpected|unrecognized|unknown|invalid)[^\n]*--json/i.test(stderr || "");
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

/** Ask Codex to exit, escalating to a hard kill if it has not gone within 2s. */
function stopGently(child) {
  if (process.platform === "win32") {
    killTree(child);
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child);
  }, 2000).unref();
}

/** Codex processes currently running, so a server shutdown can stop them all. */
const activeChildren = new Set();

/** Kill every running Codex session (used when the MCP server is shutting down). */
export function killAllCodex() {
  for (const child of activeChildren) killTree(child);
  activeChildren.clear();
}

/**
 * Spawn codex, feed the prompt via stdin, stream stderr to onProgress, enforce
 * a timeout. Cross-platform: on Windows, `.cmd`/`.bat` shims (e.g. an npm-global
 * `codex.cmd`) cannot be spawned directly, so we run them through a shell and
 * quote the arguments. A native `codex.exe` (or any non-Windows binary) is
 * spawned directly with no shell.
 */
function runCodex(args, promptStdin, { onProgress, onEvent, signal, until } = {}) {
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

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let sessionId = null;
    let lineBuf = "";
    const agentMessages = [];
    const eventErrors = [];

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, config.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // Poll `until(sessionId)`; once it reports true the work is done and Codex
    // is asked to stop (SIGTERM first, so it can close its own state cleanly).
    let stoppedEarly = false;
    let polling = false;
    const watcher = until
      ? setInterval(async () => {
          if (polling || stoppedEarly || aborted || timedOut) return;
          polling = true;
          try {
            if (await until(sessionId)) {
              stoppedEarly = true;
              stopGently(child);
            }
          } catch {
            /* keep waiting for Codex to finish on its own */
          } finally {
            polling = false;
          }
        }, 250)
      : null;

    const cleanup = () => {
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      activeChildren.delete(child);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const handleLine = (line) => {
      const ev = parseCodexEvent(line);
      if (!ev) return;
      if (ev.sessionId && !sessionId) sessionId = ev.sessionId;
      if (ev.agentText) agentMessages.push(ev.agentText);
      if (ev.error) eventErrors.push(ev.error);
      if (onEvent) onEvent(ev);
    };

    // Feed the prompt to Codex via stdin, then close it.
    if (child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if codex exits early
      child.stdin.write(promptStdin);
      child.stdin.end();
    }

    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      lineBuf += text;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
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
      cleanup();
      // ENOENT means the command (often a bare `codex` on PATH) wasn't found.
      const kind = err.code === "ENOENT" ? "binary_missing" : "spawn_failed";
      const msg =
        err.code === "ENOENT"
          ? `Could not find the Codex binary ("${config.codexBin}"). Install the Codex CLI and ensure it's on your PATH, or set CODEX_BIN to its absolute path.`
          : `Codex process error: ${err.message}`;
      reject(new PixmithError(kind, msg));
    });
    child.on("close", (code) => {
      cleanup();
      if (lineBuf.trim()) handleLine(lineBuf);
      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        aborted,
        stoppedEarly,
        sessionId,
        agentText: agentMessages.join("\n"),
        eventErrors,
      });
    });
  });
}
