import path from "node:path";

import { config, expandHome } from "./config.js";
import { ImageHistory } from "./history.js";
import { formatBytes, pruneCodexCopies } from "./prune.js";

// Commands for `pixmith <command>` (or `node src/index.js <command>`). With no
// command, index.js starts the MCP server as usual.

const USAGE = `Usage:
  pixmith                         start the MCP server (what MCP clients run)
  pixmith prune-codex-copies      delete Codex's duplicate copies of images Pixmith made
  pixmith prune-codex-copies --dry-run   only show what would be deleted
    --state-dir <dir>     the server's state folder (PIXMITH_STATE_DIR), where its image history is
    --codex-home <dir>    Codex's home folder, when it is not ~/.codex (CODEX_HOME)
  pixmith --version
  pixmith --help`;

export const COMMANDS = new Set(["prune-codex-copies", "--help", "-h", "help", "--version", "-v"]);

/** Run a command; returns the exit code. `out`/`err` default to stdout/stderr. */
export async function runCli(
  args,
  { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), history } = {},
) {
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") {
    out(config.version);
    return 0;
  }
  if (command !== "prune-codex-copies") {
    out(USAGE);
    return 0;
  }
  // A server installed as a plugin or bundle keeps its history in its own state
  // folder, which a terminal run cannot know: pixmith_status prints the exact
  // command, with these options filled in.
  let dryRun = false;
  let stateDir = config.stateDir;
  const unknown = [];
  for (let i = 0; i < rest.length; i += 1) {
    const [flag, inline] = rest[i].split(/=(.*)/s);
    if (flag === "--dry-run" && inline === undefined) {
      dryRun = true;
    } else if (flag === "--state-dir" || flag === "--codex-home") {
      const value = inline ?? rest[(i += 1)];
      if (!value) {
        err(`${flag} needs a folder.\n\n${USAGE}`);
        return 1;
      }
      const dir = path.resolve(expandHome(value));
      if (flag === "--state-dir") stateDir = dir;
      else config.codexHome = dir;
    } else {
      unknown.push(rest[i]);
    }
  }
  if (unknown.length) {
    err(`Unknown option: ${unknown.join(" ")}\n\n${USAGE}`);
    return 1;
  }
  const h = history ?? new ImageHistory({ file: path.join(stateDir, "history.jsonl") });
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
