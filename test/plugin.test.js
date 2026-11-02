import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, p), "utf8"));

test("plugin.json version matches package.json, so plugin users get updates", async () => {
  const pkg = await readJson("package.json");
  const plugin = await readJson(".claude-plugin/plugin.json");
  assert.equal(plugin.version, pkg.version);
});

test("the marketplace lists this repo's plugin under its manifest name", async () => {
  const plugin = await readJson(".claude-plugin/plugin.json");
  const market = await readJson(".claude-plugin/marketplace.json");
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, "marketplace entry for the plugin");
  assert.equal(entry.source, ".");
});

test("the plugin's MCP server points at the real entry point and keeps state out of the install folder", async () => {
  const { mcpServers } = await readJson(".claude-plugin/plugin.json");
  const server = mcpServers.pixmith;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/index.js"]);
  await fs.access(path.join(ROOT, "src/index.js"));
  assert.match(server.env.PIXMITH_STATE_DIR, /^\$\{CLAUDE_PLUGIN_DATA\}/);
  assert.equal(
    server.env.PIXMITH_DEFAULT_OUTPUT_DIR,
    "~/Pictures/Pixmith",
    "images must not land in the versioned install folder",
  );
  assert.equal(
    server.env.PIXMITH_OUTPUT_DIR,
    undefined,
    "the user's own PIXMITH_OUTPUT_DIR must stay free to override",
  );
});

test("no root .mcp.json: it would load as a broken project server when the repo itself is opened", async () => {
  await assert.rejects(fs.access(path.join(ROOT, ".mcp.json")));
});

test("skills: portable frontmatter with a name matching the folder and a description under 1024 characters", async () => {
  const dirs = await fs.readdir(path.join(ROOT, "skills"));
  assert.ok(dirs.length >= 2);
  for (const dir of dirs) {
    // Windows checkouts may convert line endings to CRLF; Claude Code reads either.
    const text = (await fs.readFile(path.join(ROOT, "skills", dir, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, `${dir}: frontmatter must open on line 1`);
    const fields = Object.fromEntries(
      m[1]
        .split("\n")
        .map((l) => l.match(/^([a-z-]+):\s*(.*)$/))
        .filter(Boolean)
        .map((x) => [x[1], x[2]]),
    );
    assert.deepEqual(
      Object.keys(fields).sort(),
      ["description", "name"],
      `${dir}: only name and description, so the file also uploads to Claude Desktop`,
    );
    assert.equal(fields.name, dir);
    assert.match(fields.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(
      fields.description.length > 0 && fields.description.length <= 1024,
      `${dir}: description is ${fields.description.length} chars`,
    );
  }
});
