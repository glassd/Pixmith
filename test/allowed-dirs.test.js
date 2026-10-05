import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertOutputDirAllowed } from "../src/codex.js";
import { parseAllowedDirs } from "../src/config.js";

test("parseAllowedDirs: unset allows anything; relative entries are ignored with a warning", () => {
  assert.equal(parseAllowedDirs(undefined, []), null);
  assert.equal(parseAllowedDirs("  ", []), null);

  const warnings = [];
  const abs = path.resolve("/data/images");
  assert.deepEqual(parseAllowedDirs(`${abs}${path.delimiter} relative/dir ${path.delimiter}${path.delimiter}`, warnings), [abs]);
  assert.deepEqual(warnings, ['PIXMITH_ALLOWED_DIRS entry "relative/dir" is not an absolute path and was ignored.']);

  // Set, but nothing usable: only the default output folder stays allowed (never "anything").
  assert.deepEqual(parseAllowedDirs("nope", []), []);
});

async function withDirs(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-allowed-")));
  const allowed = path.join(root, "images");
  const other = path.join(root, "elsewhere");
  const defaults = path.join(root, "default-out");
  await Promise.all([allowed, other, defaults].map((d) => fs.mkdir(d, { recursive: true })));
  const opts = { allowedDirs: [allowed], defaultOutputDir: defaults };
  const ok = (dir) => assertOutputDirAllowed(dir, opts);
  const refused = (dir) => assert.rejects(ok(dir), (e) => e.kind === "dir_not_allowed", dir);
  try {
    await fn({ root, allowed, other, defaults, ok, refused });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("assertOutputDirAllowed: inside allowed folders, including ones not created yet", () =>
  withDirs(async ({ allowed, defaults, ok }) => {
    await ok(allowed);
    await ok(path.join(allowed, "logos", "2026", "not-yet-created"));
    await ok(path.join(defaults, "sub")); // the default output folder is always allowed
  }));

test("assertOutputDirAllowed: outside, look-alike prefixes and .. are refused", () =>
  withDirs(async ({ root, allowed, other, refused }) => {
    await refused(other);
    await refused(root);
    await refused(`${allowed}-evil`);
    await refused(path.join(allowed, "..", "elsewhere"));
    await refused(path.join(allowed, "sub", "..", "..", "elsewhere"));
  }));

test("assertOutputDirAllowed: a symlink cannot lead out of an allowed folder", { skip: process.platform === "win32" && "creating symlinks needs extra rights on Windows" }, () =>
  withDirs(async ({ allowed, other, ok, refused }) => {
    await fs.symlink(other, path.join(allowed, "escape"));
    await refused(path.join(allowed, "escape"));
    await refused(path.join(allowed, "escape", "deeper", "not-yet-created"));

    // ...but a link into an allowed folder is fine.
    await fs.symlink(allowed, path.join(other, "into-allowed"));
    await ok(path.join(other, "into-allowed", "sub"));
  }));

test("assertOutputDirAllowed: no allowlist allows any folder; an empty one only the default", () =>
  withDirs(async ({ other, defaults }) => {
    await assertOutputDirAllowed(other, { allowedDirs: null, defaultOutputDir: defaults });
    await assert.rejects(assertOutputDirAllowed(other, { allowedDirs: [], defaultOutputDir: defaults }), (e) => e.kind === "dir_not_allowed");
    await assertOutputDirAllowed(defaults, { allowedDirs: [], defaultOutputDir: defaults });
  }));

test("assertOutputDirAllowed: case-insensitive where the file system usually is", { skip: !["win32", "darwin"].includes(process.platform) && "case-sensitive file systems" }, () =>
  withDirs(async ({ allowed, ok }) => {
    await ok(allowed.toUpperCase());
  }));
