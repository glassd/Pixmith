import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { removeCodexCopy } from "./codex.js";

// Codex keeps its own copy of every image under CODEX_HOME/generated_images,
// next to the one Pixmith saves. These helpers find those duplicates through
// the image history, and delete them on request (`pixmith prune-codex-copies`).

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function sha256(p) {
  return createHash("sha256")
    .update(await fs.readFile(p))
    .digest("hex");
}

/** How many of Codex's copies of Pixmith images are still on disk, and their size. */
export async function codexCopyStats(history) {
  let count = 0;
  let bytes = 0;
  const seen = new Set();
  for (const e of history ? await history.entries() : []) {
    if (!e.codex_copy || seen.has(e.codex_copy)) continue;
    seen.add(e.codex_copy);
    const st = await statOrNull(e.codex_copy);
    if (st?.isFile()) {
      count += 1;
      bytes += st.size;
    }
  }
  return { count, bytes };
}

/**
 * Delete Codex's copies of images Pixmith made, as recorded in the history. A
 * copy is deleted only when Pixmith's own copy still exists with exactly the
 * same bytes, and only inside CODEX_HOME/generated_images. With `dryRun`,
 * nothing is deleted and the result says what would be.
 * Returns { removed: string[], bytes, kept: [{ path, reason }] }.
 */
export async function pruneCodexCopies({ history, dryRun = false, remove = removeCodexCopy }) {
  const removed = [];
  const kept = [];
  let bytes = 0;
  const seen = new Set();
  for (const e of history ? await history.entries() : []) {
    const copy = e.codex_copy;
    if (!copy || seen.has(copy)) continue;
    seen.add(copy);
    const [codexSt, ownSt] = await Promise.all([statOrNull(copy), statOrNull(e.path)]);
    if (!codexSt) continue; // already gone
    if (!ownSt) {
      kept.push({ path: copy, reason: "Pixmith's copy no longer exists" });
    } else if (codexSt.size !== ownSt.size || (await sha256(copy)) !== (await sha256(e.path))) {
      kept.push({ path: copy, reason: "it differs from Pixmith's copy" });
    } else if (await remove(copy, { dryRun })) {
      removed.push(copy);
      bytes += codexSt.size;
    } else {
      kept.push({ path: copy, reason: "it is not inside CODEX_HOME/generated_images, or could not be deleted" });
    }
  }
  return { removed, bytes, kept };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
