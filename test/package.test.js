import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultDirs, readEnv } from "../src/config.js";
import { createTools } from "../src/tools.js";

const read = async (file) => JSON.parse(await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8"));

test("readEnv: unset, blank and unfilled bundle placeholders all count as unset", () => {
  const env = { A: "  value ", B: "", C: "   ", D: "${user_config.output_dir}", E: " ${HOME} ", F: "${x}/images" };
  assert.equal(readEnv("A", env), "value");
  assert.equal(readEnv("B", env), null);
  assert.equal(readEnv("C", env), null);
  assert.equal(readEnv("D", env), null, "Claude Desktop passes a blank optional setting as its placeholder");
  assert.equal(readEnv("E", env), null);
  assert.equal(readEnv("F", env), "${x}/images", "only a value that is nothing but a placeholder is dropped");
  assert.equal(readEnv("MISSING", env), null);
});

test("defaultDirs: a git checkout keeps the project folders; an installed copy uses per-user folders", () => {
  const root = path.resolve("/opt/pixmith");
  const home = path.resolve("/home/me");
  const only = (...paths) => (p) => paths.includes(p);

  assert.deepEqual(defaultDirs({ root, home, exists: only(path.join(root, ".git")) }), {
    images: path.join(root, "images"),
    state: path.join(root, ".pixmith"),
    installed: false,
  });

  const pictures = only(path.join(home, "Pictures"));
  assert.deepEqual(defaultDirs({ root, home, platform: "darwin", exists: pictures }), {
    images: path.join(home, "Pictures", "Pixmith"),
    state: path.join(home, "Library", "Application Support", "Pixmith"),
    installed: true,
  });
  assert.equal(defaultDirs({ root, home, platform: "linux", env: {}, exists: pictures }).state, path.join(home, ".local", "state", "pixmith"));
  assert.equal(
    defaultDirs({ root, home, platform: "linux", env: { XDG_STATE_HOME: path.resolve("/xdg") }, exists: pictures }).state,
    path.join(path.resolve("/xdg"), "pixmith"),
  );
  assert.equal(
    defaultDirs({ root, home, platform: "win32", env: { LOCALAPPDATA: path.resolve("/appdata") }, exists: pictures }).state,
    path.join(path.resolve("/appdata"), "Pixmith"),
  );
  // No Pictures folder: straight into the home folder.
  assert.equal(defaultDirs({ root, home, platform: "linux", env: {}, exists: only() }).images, path.join(home, "Pixmith"));
});

test("manifest.json: in step with package.json and the tools", async () => {
  const [manifest, pkg] = await Promise.all([read("manifest.json"), read("package.json")]);
  assert.equal(manifest.version, pkg.version, "bump both versions together");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.entry_point, pkg.main);
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${pkg.main}`]);

  const { tools } = createTools({ jobs: { stats: { estimate: () => 40_000 } }, config: { pollWaitMs: 45_000 } });
  assert.deepEqual(manifest.tools.map((t) => t.name), tools.map((t) => t.name), "manifest.json lists every tool, in order");

  // Every setting is passed on, and every placeholder names a setting.
  const used = Object.values(manifest.server.mcp_config.env).map((v) => v.match(/^\$\{user_config\.(\w+)\}$/)?.[1]);
  assert.ok(used.every(Boolean), "env values are whole placeholders, which Pixmith treats as unset when left blank");
  assert.deepEqual([...used].sort(), Object.keys(manifest.user_config).sort());
  await fs.access(new URL(`../${manifest.icon}`, import.meta.url));
});

test(".mcpbignore: project-level patterns are anchored to the root", async () => {
  const lines = (await fs.readFile(new URL("../.mcpbignore", import.meta.url), "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    // A bare "dist/" would also drop node_modules/@modelcontextprotocol/sdk/dist/.
    assert.ok(line.startsWith("/") || line.startsWith("*."), `"${line}" must start with "/" (or be an extension like *.mcpb)`);
  }
});
