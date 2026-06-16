# Pixmith

**Generate images from your MCP client (e.g. Claude) using the OpenAI Codex CLI — on your ChatGPT subscription, no API key required.**

> ℹ️ **Unofficial project.** Pixmith is an independent, community tool. It is **not
> affiliated with, endorsed by, or supported by OpenAI or Anthropic.** "Codex",
> "ChatGPT", "OpenAI", "Claude", and "Anthropic" are trademarks of their respective
> owners.

Pixmith is a small local [MCP](https://modelcontextprotocol.io) server. It exposes a
single `generate_image` tool to an MCP client (such as Claude Desktop or Claude Code).
Under the hood it drives the **OpenAI Codex CLI** and its built-in `$imagegen` skill
(`gpt-image-2`). Because Codex can be signed in with your **ChatGPT account**,
generation can run on your ChatGPT plan instead of a paid API key.

> ⚠️ When using ChatGPT-subscription auth, image generation counts toward your
> ChatGPT plan's usage limits.

---

## How it works

```
MCP client ──MCP(stdio)──▶ Pixmith ──spawn──▶ codex exec "$imagegen …" ──▶ gpt-image-2
                              ▲                                                  │
                              └──────────── PNG path + inline image ◀───────────┘
```

1. The client calls `generate_image` with a prompt (and optional size / output dir).
2. Pixmith runs `codex exec` with a tightly-scripted prompt that tells Codex to use
   the built-in `image_gen` tool, copy the resulting PNG to an exact path, and print
   a single `SAVED:<path>` line.
3. Pixmith locates the PNG (the exact target path → the `SAVED:` marker →, as a
   fallback, the newest file under `$CODEX_HOME/generated_images/`), and returns its
   absolute path plus the image inline.

No tokens or secrets are ever read, printed, or committed by Pixmith.

---

## Authentication: ChatGPT subscription *or* API key

Pixmith just shells out to whatever `codex` you point it at, so it works with either
way of authenticating the Codex CLI:

- **ChatGPT subscription (recommended, no API key):** sign in to Codex with your
  ChatGPT account. Image generation is billed against your ChatGPT plan's limits.
- **OpenAI API key:** if your Codex CLI is configured to use an `OPENAI_API_KEY`,
  generation is billed to your OpenAI API account instead. Pixmith does not require
  or read the key itself — it's Codex's own configuration.

Either way, Pixmith does not handle credentials directly.

---

## Prerequisites

- **The Codex CLI**, via one of:
  - the **Codex desktop app** (bundles the `codex` binary, on macOS at
    `/Applications/Codex.app/Contents/Resources/codex`), or
  - a standalone `codex` binary on your `PATH`.
- **Codex signed in** — either with your ChatGPT account *or* configured with an
  OpenAI API key (see above). Verify with `codex --version` and a quick
  `codex exec "hello"`.
- **Node.js ≥ 18.**

If your `codex` binary is not on `PATH` (e.g. the desktop-app bundle), set the
`CODEX_BIN` environment variable to its absolute path (see below).

---

## Install

```bash
git clone <your-fork-url> Pixmith
cd Pixmith
npm install
```

## Run / smoke test

The server speaks MCP over stdio, so normally your MCP client launches it. Running it
directly just verifies it boots:

```bash
npm start
```

Generate a test image directly through the engine (bypasses the MCP protocol):

```bash
npm run smoke                       # "a red circle on a white background" @ 1024x1024
node scripts/smoke-test.js "a tabby cat astronaut" 1536x1024
```

A successful run prints JSON with the saved `path`. Images land in `./images/` by
default.

---

## The `generate_image` tool

| Param        | Type   | Required | Description                                                                                 |
|--------------|--------|----------|---------------------------------------------------------------------------------------------|
| `prompt`     | string | ✅       | Text description of the image.                                                              |
| `size`       | string | ❌       | `auto`, a shortcut `1K`/`2K`/`4K`, or explicit `WIDTHxHEIGHT` (e.g. `1024x1024`, `1536x1024`). Each edge 256–3840. Default `1024x1024`. |
| `output_dir` | string | ❌       | Absolute directory to save into. Defaults to Pixmith's `images/` folder.                   |

Returns a text block (saved path, size, byte count) and, when the file is small
enough, the PNG inline as MCP image content.

---

## Environment variables

| Variable                   | Default                                              | Purpose                                                          |
|----------------------------|------------------------------------------------------|------------------------------------------------------------------|
| `CODEX_BIN`                | `/Applications/Codex.app/Contents/Resources/codex`   | Absolute path to the Codex binary. Set this if `codex` lives elsewhere or is on your `PATH` (e.g. `CODEX_BIN=codex`). |
| `PIXMITH_OUTPUT_DIR`       | `<project>/images`                                   | Default output directory for generated PNGs.                    |
| `CODEX_HOME`               | `~/.codex`                                            | Codex home (used to locate the backup `generated_images/` copy). |
| `PIXMITH_TIMEOUT_MS`       | `300000` (5 min)                                     | Hard timeout per generation.                                    |
| `PIXMITH_RETURN_IMAGE`     | `true`                                               | Set `false` to return only the path, never inline bytes.        |
| `PIXMITH_MAX_INLINE_BYTES` | `6291456` (6 MB)                                     | Files larger than this return path-only (e.g. 4K images).       |

See [`.env.example`](.env.example) for a copy-paste starting point.

---

## Register Pixmith as a connector in your MCP client

Pixmith does **not** register itself. Replace `/path/to/Pixmith` below with the
absolute path where you cloned this repo.

### Claude Desktop

Edit the Claude Desktop config and add a `pixmith` entry under `mcpServers` (merge
with anything already there):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pixmith": {
      "command": "node",
      "args": ["/path/to/Pixmith/src/index.js"],
      "env": {
        "CODEX_BIN": "/Applications/Codex.app/Contents/Resources/codex"
      }
    }
  }
}
```

Then **quit and reopen** the app. Pixmith appears as a connector exposing the
`generate_image` tool.

### Claude Code (CLI)

```bash
claude mcp add pixmith --scope user -- node /path/to/Pixmith/src/index.js
```

Or add the same `mcpServers` block above to a project-level `.mcp.json`.

### Try it

> Use Pixmith to generate a 1536x1024 image of a lighthouse at sunset.

---

## Troubleshooting

| Symptom                              | Cause / fix                                                                 |
|--------------------------------------|------------------------------------------------------------------------------|
| `[binary_missing]`                   | Codex CLI not found — install it, or set `CODEX_BIN` to the correct path.    |
| `[not_signed_in]`                    | Sign in to Codex (ChatGPT account) or configure an API key, then retry.     |
| `[timeout]`                          | Large image or slow service — raise `PIXMITH_TIMEOUT_MS`.                    |
| `[generation_failed]` / `[no_output]`| Codex ran but produced nothing; see the `Detail:` stderr tail in the error. |

---

## Security notes

- Pixmith never reads, prints, or commits Codex auth tokens (e.g. `~/.codex/auth.json`).
- `node_modules/`, generated images, and any `.env`/`auth.json`/key files are
  git-ignored.
- Codex runs with the `workspace-write` sandbox scoped to the output directory.

## License

[MIT](LICENSE).
