import path from "node:path";

import { config } from "./config.js";
import { ImageHistory } from "./history.js";
import { formatBytes, pruneCodexCopies } from "./prune.js";

// Commands for `pixmith <command>` (or `node src/index.js <command>`). With no
// command, index.js starts the MCP server as usual.

const USAGE = `Usage:
  pixmith                         start the MCP server (what MCP clients run)
  pixmith prune-codex-copies      delete Codex's duplicate copies of images Pixmith made
  pixmith prune-codex-copies --dry-run   only show what would be deleted
  pixmith --version
  pixmith --help`;

export const COMMANDS = new Set(["prune-codex-copies", "--help", "-h", "help", "--version", "-v"]);

/** Run a command; returns the exit code. `out`/`err` default to stdout/stderr. */
export async function runCli(args, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), history } = {}) {
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") {
    out(config.version);
    return 0;
  }
  if (command !== "prune-codex-copies") {
    out(USAGE);
    return 0;
  }
  const unknown = rest.filter((a) => a !== "--dry-run");
  if (unknown.length) {
    err(`Unknown option: ${unknown.join(" ")}\n\n${USAGE}`);
    return 1;
  }
  const dryRun = rest.includes("--dry-run");
  const h = history ?? new ImageHistory({ file: path.join(config.stateDir, "history.jsonl") });
  const { removed, bytes, kept } = await pruneCodexCopies({ history: h, dryRun });

  if (!removed.length && !kept.length) {
    out("Nothing to do: no duplicate copies of Pixmith images are left in Codex's folder.");
    return 0;
  }
  const n = `${removed.length} of Codex's duplicate image ${removed.length === 1 ? "copy" : "copies"}`;
  if (dryRun) {
    out(`Would remove ${n} (${formatBytes(bytes)}):`);
    for (const p of removed) out(`  ${p}`);
    if (removed.length) out("Run again without --dry-run to delete them.");
  } else if (removed.length) {
    out(`Removed ${n}, freeing ${formatBytes(bytes)}.`);
  }
  if (kept.length) {
    out(`Kept ${kept.length}:`);
    for (const k of kept) out(`  ${k.path} (${k.reason})`);
  }
  return 0;
}
