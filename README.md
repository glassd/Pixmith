# Pixmith

<p align="center">
  <img src="assets/hero.png" alt="Pixmith — a wireframe hammer striking a glowing pixel on an anvil, sparks of light bursting outward" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio_server-6E56CF)](https://modelcontextprotocol.io)
[![Powered by Codex](https://img.shields.io/badge/powered%20by-OpenAI%20Codex-412991?logo=openai&logoColor=white)](https://openai.com/codex)

**Generate images from your MCP client (e.g. Claude) using the OpenAI Codex CLI — on your ChatGPT subscription, no image API key required.**

Pixmith is a small local [MCP](https://modelcontextprotocol.io) server that exposes a
single `generate_image` tool to any MCP client (such as Claude Desktop or Claude Code).
Under the hood it drives the **OpenAI Codex CLI** and its built-in `$imagegen` skill
(`gpt-image-2`), then hands the finished PNG back to your client — both as a file path
and inline. Ask Claude for "a watercolour fox at dawn, 1536×1024" and a real image
lands on disk seconds later.

**Why Pixmith?** Codex can be signed in with your **ChatGPT account**, so image
generation runs against your existing ChatGPT plan instead of a separate, metered image
API key. If you already pay for ChatGPT, you get image generation in Claude for no extra
cost — and Pixmith works just as well if your Codex is configured with an OpenAI API key
instead.

> ℹ️ **Unofficial project.** Pixmith is an independent, community tool. It is **not
> affiliated with, endorsed by, or supported by OpenAI or Anthropic.** "Codex",
> "ChatGPT", "OpenAI", "Claude", and "Anthropic" are trademarks of their respective
> owners.

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

Pixmith runs on **macOS, Windows, and Linux**.

- **The Codex CLI**, via one of:
  - the **Codex desktop app** (bundles the `codex` binary), or
  - a standalone `codex` binary on your `PATH`.
- **Codex signed in** — either with your ChatGPT account *or* configured with an
  OpenAI API key (see above). Verify with `codex --version` and a quick
  `codex exec "hello"`.
- **Node.js ≥ 18.**

### Finding the Codex binary

Pixmith auto-detects the Codex binary in the common per-OS install locations and
otherwise falls back to whatever `codex` is on your `PATH`. If auto-detection
misses, set `CODEX_BIN` to the absolute path. To locate it:

| OS      | Find it with             | Typical location                                                        |
|---------|--------------------------|-------------------------------------------------------------------------|
| macOS   | `which codex`            | `/Applications/Codex.app/Contents/Resources/codex` (desktop app bundle) |
| Windows | `where codex` (cmd)      | `%LOCALAPPDATA%\Programs\codex\codex.exe`, or `%APPDATA%\npm\codex.cmd`  |
| Linux   | `which codex`            | `/usr/local/bin/codex`, `~/.local/bin/codex`                            |

> **Windows note:** both a native `codex.exe` and an npm-installed `codex.cmd`
> shim work — Pixmith handles each. If you point `CODEX_BIN` at a `.cmd`/`.bat`,
> Pixmith runs it through the shell automatically. Use a full absolute path, and
> in JSON configs either use forward slashes (`C:/Users/you/...`) or escaped
> backslashes (`C:\\Users\\you\\...`).

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

## The tools

A generation takes ~50–90s — longer than the per-request timeout many MCP clients
(e.g. Claude Desktop) enforce, and some clients won't extend that timeout. So
Pixmith never blocks on the long call. It exposes **two tools** and the assistant
uses them together automatically:

### `generate_image` — starts a job, returns instantly

| Param        | Type   | Required | Description                                                                                 |
|--------------|--------|----------|---------------------------------------------------------------------------------------------|
| `prompt`     | string | ✅       | Text description of the image.                                                              |
| `size`       | string | ❌       | `auto`, a shortcut `1K`/`2K`/`4K`, or explicit `WIDTHxHEIGHT` (e.g. `1024x1024`, `1536x1024`). Each edge 256–3840. Default `1024x1024`. |
| `output_dir` | string | ❌       | Absolute directory to save into. Defaults to Pixmith's `images/` folder.                   |

Returns immediately with a `job_id` (it does **not** return the image).

### `get_image_result` — fetches the finished image

| Param    | Type   | Required | Description                          |
|----------|--------|----------|--------------------------------------|
| `job_id` | string | ✅       | The `job_id` from `generate_image`.  |

Waits up to ~25s, then returns. While the image is still rendering it returns
`status: running` — the assistant simply calls it again with the same `job_id`
(usually 2–4 times) until `status: done`, at which point it returns the saved
absolute path and, when small enough, the PNG inline. **Every call is short, so
no single request trips a client-side timeout.** You don't manage this yourself —
just ask for an image and the assistant drives both tools.

---

## Environment variables

| Variable                   | Default                                              | Purpose                                                          |
|----------------------------|------------------------------------------------------|------------------------------------------------------------------|
| `CODEX_BIN`                | auto-detected, else `codex` on `PATH`                | Path to the Codex binary. Set this if auto-detection misses (e.g. `CODEX_BIN=C:/Users/you/AppData/Local/Programs/codex/codex.exe`). |
| `PIXMITH_SANDBOX`          | `workspace-write`                                    | Sandbox policy passed to `codex exec`. Override only if your platform needs a different policy (e.g. `read-only`, `danger-full-access`). |
| `PIXMITH_POLL_WAIT_MS`     | `25000` (25s)                                        | Max wait per `get_image_result` call. Lower it if your MCP client's request timeout is under ~30s. |
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

macOS / Linux:

```json
{
  "mcpServers": {
    "pixmith": {
      "command": "node",
      "args": ["/path/to/Pixmith/src/index.js"]
    }
  }
}
```

Windows (note forward slashes, or escaped `\\`, in JSON):

```json
{
  "mcpServers": {
    "pixmith": {
      "command": "node",
      "args": ["C:/path/to/Pixmith/src/index.js"]
    }
  }
}
```

`CODEX_BIN` is auto-detected, so it's usually omitted. Add it under `"env"` only
if you need to override the detected path, e.g.
`"env": { "CODEX_BIN": "C:/Users/you/AppData/Local/Programs/codex/codex.exe" }`.

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
| Client times out during generation | Shouldn't happen: `generate_image` returns instantly and `get_image_result` waits at most ~25s per call. If your client's request timeout is under ~30s, lower `PIXMITH_POLL_WAIT_MS` to match. The PNG is still saved either way — check `output_dir` (and `$CODEX_HOME/generated_images/`). |
| `[unknown_job]` from get_image_result | The job_id expired (>15 min) or generation was never started — call `generate_image` first, then poll with the returned job_id. |

> **A note on timing.** A generation is an agent session, not a raw API call, so it
> takes ~50–90s. To stay under client request timeouts, Pixmith never blocks on the
> long call: `generate_image` starts a background job and returns a `job_id`
> immediately, and `get_image_result` retrieves it with a short bounded wait. The
> assistant polls a few times until it's done — no single request runs long enough
> to time out, regardless of how the client handles progress notifications.

---

## Security notes

- Pixmith never reads, prints, or commits Codex auth tokens (e.g. `~/.codex/auth.json`).
- `node_modules/`, generated images, and any `.env`/`auth.json`/key files are
  git-ignored.
- Codex runs with the `workspace-write` sandbox scoped to the output directory.

## License

[MIT](LICENSE).
