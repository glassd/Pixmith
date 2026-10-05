import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// config.js reads CODEX_HOME at import time, so it is set first.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pixmith-prune-")));
const codexHome = path.join(root, "codex-home");
process.env.CODEX_HOME = codexHome;
const { codexCopyStats, formatBytes, pruneCodexCopies } = await import("../src/prune.js");
const { runCli } = await import("../src/cli.js");

test.after(() => fs.rm(root, { recursive: true, force: true }));

const generated = path.join(codexHome, "generated_images");

/** A Pixmith image and Codex's copy of it; `codexBytes` makes the copy differ. */
async function pair(name, { session = name, bytes = `png-${name}`, codexBytes = bytes, own = true } = {}) {
  const ownPath = path.join(root, "images", `${name}.png`);
  const copy = path.join(generated, session, "ig_1.png");
  await fs.mkdir(path.dirname(ownPath), { recursive: true });
  await fs.mkdir(path.dirname(copy), { recursive: true });
  if (own) await fs.writeFile(ownPath, bytes);
  await fs.writeFile(copy, codexBytes);
  return { job_id: name, path: ownPath, codex_copy: copy };
}

const historyOf = (entries) => ({ entries: async () => entries });
const exists = (p) => fs.access(p).then(() => true, () => false);

test("pruneCodexCopies: deletes only byte-identical copies inside generated_images", async () => {
  await fs.rm(generated, { recursive: true, force: true });
  const same = await pair("same");
  const shared = await pair("shared-a", { session: "shared" });
  await fs.writeFile(path.join(generated, "shared", "other.png"), "another image in that session");
  const differs = await pair("differs", { codexBytes: "png-something-else" });
  const orphan = await pair("orphan", { own: false });
  const outsideCopy = path.join(root, "not-codex.png");
  await fs.writeFile(outsideCopy, "png-outside");
  await fs.writeFile(path.join(root, "images", "outside.png"), "png-outside");
  const outside = { job_id: "outside", path: path.join(root, "images", "outside.png"), codex_copy: outsideCopy };
  const gone = { job_id: "gone", path: same.path, codex_copy: path.join(generated, "nope", "ig_1.png") };
  const history = historyOf([same, same, shared, differs, orphan, outside, gone]);

  // Every Codex copy still on disk counts, once each: same, shared-a, differs, orphan and the outside one.
  const sizes = ["png-same", "png-shared-a", "png-something-else", "png-orphan", "png-outside"].map((t) => t.length);
  assert.deepEqual(await codexCopyStats(history), { count: 5, bytes: sizes.reduce((a, b) => a + b) });

  const preview = await pruneCodexCopies({ history, dryRun: true });
  assert.deepEqual(preview.removed, [same.codex_copy, shared.codex_copy]);
  assert.ok(await exists(same.codex_copy), "a dry run deletes nothing");

  const result = await pruneCodexCopies({ history });
  assert.deepEqual(result.removed, [same.codex_copy, shared.codex_copy]);
  assert.equal(result.bytes, "png-same".length + "png-shared-a".length);
  assert.deepEqual(
    result.kept.map((k) => [path.basename(path.dirname(k.path)) || k.path, k.reason]),
    [
      ["differs", "it differs from Pixmith's copy"],
      ["orphan", "Pixmith's copy no longer exists"],
      [path.basename(root), "it is not inside CODEX_HOME/generated_images, or could not be deleted"],
    ],
  );
  assert.equal(await exists(same.codex_copy), false);
  assert.equal(await exists(path.join(generated, "same")), false, "an emptied session folder goes too");
  assert.ok(await exists(path.join(generated, "shared", "other.png")), "a session folder with other files stays");
  assert.ok(await exists(differs.codex_copy));
  assert.ok(await exists(outsideCopy), "nothing outside generated_images is ever deleted");
  assert.ok(await exists(same.path), "Pixmith's own copies are untouched");
});

test("pruneCodexCopies: a symlinked folder cannot lead the delete out of generated_images", { skip: process.platform === "win32" && "creating symlinks needs extra rights on Windows" }, async () => {
  await fs.rm(generated, { recursive: true, force: true });
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(elsewhere, "ig_1.png"), "png-x");
  await fs.mkdir(generated, { recursive: true });
  await fs.symlink(elsewhere, path.join(generated, "evil"));
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "images", "x.png"), "png-x");
  const entry = { job_id: "x", path: path.join(root, "images", "x.png"), codex_copy: path.join(generated, "evil", "ig_1.png") };

  const result = await pruneCodexCopies({ history: historyOf([entry]) });
  assert.deepEqual(result.removed, []);
  assert.ok(await exists(path.join(elsewhere, "ig_1.png")));
});

test("pixmith prune-codex-copies: reports what it did, and what a dry run would do", async () => {
  await fs.rm(generated, { recursive: true, force: true });
  const a = await pair("cli-a");
  const b = await pair("cli-b", { codexBytes: "changed" });
  const history = historyOf([a, b]);
  const run = async (args) => {
    const lines = [];
    const code = await runCli(args, { out: (s) => lines.push(s), err: (s) => lines.push(s), history });
    return { code, text: lines.join("\n") };
  };

  let r = await run(["prune-codex-copies", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.match(r.text, /^Would remove 1 of Codex's duplicate image copy \(9 bytes\):\n {2}.*cli-a.*ig_1\.png\nRun again without --dry-run to delete them\.\nKept 1:\n {2}.*cli-b.*\(it differs from Pixmith's copy\)$/);

  r = await run(["prune-codex-copies"]);
  assert.match(r.text, /^Removed 1 of Codex's duplicate image copy, freeing 9 bytes\.\nKept 1:/);
  assert.equal(await exists(a.codex_copy), false);

  r = await run(["prune-codex-copies", "--force"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /^Unknown option: --force/);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 bytes");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(31.4 * 1024 * 1024), "31.4 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
});
