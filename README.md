# Pixmith

<p align="center">
  <img src="assets/hero.png" alt="Pixmith — a forging hammer coming down on a glowing cube of pixels on an anvil, square embers scattering to both sides" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio_server-6E56CF)](https://modelcontextprotocol.io)
[![Powered by Codex](https://img.shields.io/badge/powered%20by-OpenAI%20Codex-412991?logo=openai&logoColor=white)](https://openai.com/codex)

**Generate images from your MCP client (e.g. Claude) using the OpenAI Codex CLI — on your ChatGPT subscription, no image API key required.**

Pixmith is a small local [MCP](https://modelcontextprotocol.io) server that lets any MCP
client (such as Claude Desktop or Claude Code) **generate and edit images**. Under the
hood it drives the **OpenAI Codex CLI** and its built-in `$imagegen` skill
(`gpt-image-2`), then hands the finished PNG back to your client — both as a file path
and inline. Ask Claude for "a watercolour fox at dawn, 1536×1024" and a real image
lands on disk about half a minute later; then say "make it snowing" and Pixmith edits
that same image.

- **One call in the common case.** `generate_image` waits for the image and returns it
  directly; polling is only the fallback for slow jobs.
- **Live feedback.** Progress updates carry the real stage reported by Codex and the
  elapsed time against what generations usually take on your machine.
- **Editing.** `edit_image` changes an existing image — a previous result or any local
  file — and both tools accept reference images.
- **Cancellation.** `cancel_image` stops a job and its Codex session immediately.
- **Usage awareness.** Every result shows how much of your ChatGPT plan's Codex limit is
  used and when it resets, warns when you are close, and asks before a job would run on
  paid credits.

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

1. The client calls `generate_image` (or `edit_image`) with a prompt. Pixmith validates
   the request — size, output directory, input images — and queues a job.
2. Pixmith runs `codex exec --json` with a tightly-scripted prompt that tells Codex to
   call the built-in `image_gen` tool exactly once and reply `DONE` (or
   `ERROR: <reason>`). Images to edit or reference are attached to that prompt. The
   agent is told not to copy files or run shell commands — Pixmith handles that.
3. Codex streams JSON events while it works. Pixmith turns them into stages (session
   started, rendering, finishing) and reports them as MCP progress notifications,
   together with the elapsed time and the typical duration of recent jobs.
4. **Pixmith trims the agent's overhead.** For plain generations the image prompt is
   handed to the agent in a file, so its tool call stays a few lines long instead of
   retyping the whole prompt token by token. And as soon as the finished PNG is on disk,
   Pixmith stops Codex rather than waiting for the agent's closing turn. Together these
   took a long-prompt 1536×1024 generation from ~46s to ~34s; what remains is almost
   entirely OpenAI's render time.
5. Codex writes the PNG to `$CODEX_HOME/generated_images/<session id>/`. Pixmith takes
   the session id from Codex's event stream, copies that session's PNG into the
   requested output directory, and validates it is a real PNG. If no file was written
   (seen on Windows), it decodes the image from the base64 in Codex's output or the
   session's rollout log instead.
6. The same tool call returns the absolute path plus the image inline. If the job
   outlasts the wait window (~45s), the call returns a `job_id` instead and the client
   collects the image with `get_image_result`.

Because each job is matched to its own Codex session, concurrent jobs can never pick
up each other's image.

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
| macOS   | `which codex`            | `/Applications/Codex.app/Contents/Resources/codex` (desktop app bundle), or `~/.local/bin/codex` (standalone installer) |
| Windows | `where codex` (cmd)      | `%LOCALAPPDATA%\Programs\codex\codex.exe`, or `%APPDATA%\npm\codex.cmd`  |
| Linux   | `which codex`            | `/usr/local/bin/codex`, `~/.local/bin/codex`                            |

If `CODEX_BIN` points at a file that no longer exists — for example Codex was
reinstalled somewhere else after you configured your MCP client — Pixmith falls back to
auto-detection instead of failing, and adds a `Note:` to each result so you can clean up
the stale setting.

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
node scripts/smoke-test.js "make the helmet gold" auto /abs/path/to/cat.png   # edit
```

A successful run prints JSON with the saved `path`. Images land in `./images/` by
default.

Unit tests (no Codex needed):

```bash
npm test
```

---

## The tools

A generation is a Codex agent session, so it takes roughly 30–40s (edits about twice
that) — close to the per-request timeout some MCP clients enforce. Pixmith therefore
never blocks a single call for longer than the **wait window** (`PIXMITH_POLL_WAIT_MS`,
default 45s). A typical generation fits inside it, so the usual flow is **one tool
call that returns the image**. If the window closes while Codex has already finished and
the image is only being collected, the call waits up to 8s more (never beyond 58s in
total) rather than costing another round trip. Slower jobs fall back to a `job_id` plus
`get_image_result`. The assistant drives all of this automatically.

### `generate_image` — make an image

| Param              | Type     | Required | Description                                                                                 |
|--------------------|----------|----------|---------------------------------------------------------------------------------------------|
| `prompt`           | string   | ✅       | Text description of the image.                                                              |
| `size`             | string   | ❌       | `auto`, a shortcut `1K`/`2K`/`4K`, or explicit `WIDTHxHEIGHT` (e.g. `1024x1024`, `1536x1024`, `3840x2160`). See [size limits](#size-limits). Default `1024x1024`. |
| `reference_images` | string[] | ❌       | Up to 4 absolute paths of images (PNG, JPEG, WebP, GIF) to use as style, composition or subject references. |
| `output_dir`       | string   | ❌       | Absolute directory to save into. Defaults to Pixmith's `images/` folder.                   |
| `wait`             | boolean  | ❌       | Default `true`: wait up to the wait window and return the image directly. `false` returns the `job_id` at once — handy for starting several jobs back to back. |
| `use_credits`      | boolean  | ❌       | Only matters once the plan limit is used up: confirms that you agreed to continue on paid credits. See [plan usage and credits](#plan-usage-and-credits). |

Invalid sizes, relative `output_dir` paths and unreadable input images are rejected
here, before any Codex session starts. If more than `PIXMITH_MAX_CONCURRENT` jobs are in
flight the new one is reported as `status: queued` with its position.

### `edit_image` — change an existing image

| Param              | Type     | Required | Description                                                                 |
|--------------------|----------|----------|-----------------------------------------------------------------------------|
| `image`            | string   | ✅       | Absolute path of the image to edit — a previous Pixmith result or any local PNG, JPEG, WebP or GIF (max 20 MB). |
| `prompt`           | string   | ✅       | What to change. Say what must stay the same, e.g. "make the sky stormy; keep everything else unchanged". |
| `reference_images` | string[] | ❌       | Extra images to borrow style or content from (up to 4 images in total).     |
| `size`             | string   | ❌       | As above. Defaults to `auto`, which keeps the source's aspect ratio.         |
| `output_dir`, `wait`, `use_credits` | | ❌  | As for `generate_image`.                                                    |

The source file is never modified; the edit is saved as a new PNG. Every finished result
ends with the exact `edit_image` call that would refine it, so iterating is a one-liner
for the assistant.

### `get_image_result` — collect a slower job

| Param    | Type   | Required | Description                                                     |
|----------|--------|----------|-----------------------------------------------------------------|
| `job_id` | string | ❌       | The job to fetch. Defaults to the most recent job.              |

Waits up to the wait window, then returns. While the job is waiting for a slot or still
rendering it returns `status: queued` or `status: running` with the current stage,
elapsed time and an estimate of what is left; the assistant simply calls it again until
`status: done`. Results stay available for 15 minutes and can be fetched more than once,
so an image is never lost to a client-side timeout — call `get_image_result` with no
arguments to recover it.

### `cancel_image` — stop a job

| Param    | Type   | Required | Description                                                     |
|----------|--------|----------|-----------------------------------------------------------------|
| `job_id` | string | ❌       | The job to cancel. Defaults to the most recent unfinished job.  |

A queued job is dropped; a running job's Codex session is killed at once, so it stops
using your ChatGPT quota. Pixmith also stops every running session when the MCP client
disconnects.

### Plan usage and credits

Codex records your ChatGPT plan's limits in its session logs. Pixmith reads the latest
snapshot (it never reads auth tokens) and ends every finished result with a line like:

```
Plan usage: 16% of the 5-hour limit (resets at 21:37), 3% of the weekly limit (resets Wed at 17:36).
```

Past `PIXMITH_USAGE_WARN_PERCENT` (default 80%) a warning is added, saying what happens
next: either jobs will continue on paid credits and how many you have, or they will stop
until the reset unless you add credits (ChatGPT → Settings → Usage, or Usage & Billing in
the Codex app).

Once a limit is fully used, Codex would draw on purchased credits automatically. Pixmith
does not let that happen silently. `generate_image` and `edit_image` refuse to start
with `[credits_confirmation_needed]` and tell the assistant to ask you. If you agree,
the assistant repeats the call with `use_credits: true`. Set `PIXMITH_USE_CREDITS` to
`always` to skip the question or `never` to refuse outright. Pixmith never buys credits.

The snapshot is only as fresh as your last Codex run, so usage from other Codex sessions
since then is not reflected, and credits bought a minute ago may not show yet — which is
why the confirmation can always be overridden with `use_credits: true`.

### Progress feedback

While a call waits, Pixmith sends MCP progress notifications every 3 seconds, for
clients that display them:

```
Codex session started — 3s of ~32s
Rendering the image — 18s of ~32s
Rendering the image — 41s, longer than the usual ~32s
```

The stage comes from Codex's own event stream. The "usual" figure is the median of your
last ten jobs (kept separately for generations and edits in `.pixmith/stats.json`), so
the estimate adapts to your machine, plan and image sizes.

### Size limits

`gpt-image-2` accepts `auto` or any `WIDTHxHEIGHT` where:

- each edge is a multiple of 16 (Pixmith rounds for you and notes it in the result),
- the longest edge is at most 3840 px,
- the long-to-short aspect ratio is at most 3:1, and
- the total pixel count is between 655,360 and 8,294,400.

Popular sizes: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`,
`2160x3840`. Requests outside these limits fail fast with a `[bad_request]` error
instead of after a full generation.

The model does not always return exactly the requested size (a `1024x1024` request
may come back as `1254x1254`, and `auto` has no fixed size). Pixmith reads the real
width and height from the saved PNG and reports those, noting the requested size
when it differs.

---

## Environment variables

| Variable                   | Default                                              | Purpose                                                          |
|----------------------------|------------------------------------------------------|------------------------------------------------------------------|
| `CODEX_BIN`                | auto-detected, else `codex` on `PATH`                | Path to the Codex binary. Set this if auto-detection misses (e.g. `CODEX_BIN=C:/Users/you/AppData/Local/Programs/codex/codex.exe`). |
| `PIXMITH_SANDBOX`          | `workspace-write`                                    | Sandbox policy passed to `codex exec` when the OS sandbox is used. |
| `PIXMITH_BYPASS_SANDBOX`   | `true` on Windows, else `false`                      | Run Codex without its OS sandbox. Codex sandboxing is macOS/Linux only (Seatbelt/Landlock); on Windows it blocks the file-save, so Pixmith bypasses it there. Set `true`/`false` to override. |
| `PIXMITH_POLL_WAIT_MS`     | `45000` (45s)                                        | The wait window: the longest any single tool call waits for a job (2s–55s). Lower it if your MCP client's request timeout is under ~60s. |
| `PIXMITH_EARLY_EXIT`       | `true`                                               | Stop Codex as soon as the finished PNG is on disk instead of waiting for the agent's closing turn (saves ~4–7s and the tokens of re-uploading the image). |
| `PIXMITH_FAST_PROMPT`      | `true` (`false` on Windows)                          | Hand the image prompt to the agent in a temp file so it does not retype it into its tool call (saves ~1s per 150 characters of prompt). Generations only; edits keep the agent's own rewrite. Falls back to the normal path if Codex's script tools are unavailable. |
| `PIXMITH_CODEX_MODEL`      | *(Codex config)*                                     | Model for the agent that wraps the image call, e.g. a faster one. Does not change the image model. In testing this made little difference — the wrapper's cost is output speed, which the fast path removes. A value with characters outside letters, digits, `.`, `:`, `-`, `_` is ignored, with a warning in the server's startup log. |
| `PIXMITH_CODEX_EFFORT`     | *(Codex config)*                                     | Reasoning effort for that agent (`low`, `medium`, …).            |
| `PIXMITH_SHOW_USAGE`       | `true`                                               | Add the plan usage line (and near-limit warning) to results.    |
| `PIXMITH_USAGE_WARN_PERCENT` | `80`                                               | Warn once any plan window is this full.                          |
| `PIXMITH_USE_CREDITS`      | `ask`                                                | When the plan limit is used up: `ask` (require `use_credits: true`), `always` (run on credits without asking), or `never` (refuse). |
| `PIXMITH_STATE_DIR`        | `<project>/.pixmith`                                 | Where Pixmith keeps its recent job durations (used for time estimates). |
| `PIXMITH_OUTPUT_DIR`       | `<project>/images`                                   | Default output directory for generated PNGs.                    |
| `CODEX_HOME`               | `~/.codex`                                            | Codex home (used to locate the backup `generated_images/` copy). |
| `PIXMITH_TIMEOUT_MS`       | `300000` (5 min)                                     | Hard timeout per generation.                                    |
| `PIXMITH_MAX_CONCURRENT`   | `1`                                                  | How many Codex generations may run at once. Extra jobs queue.   |
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
`generate_image`, `edit_image`, `get_image_result` and `cancel_image` tools.

### Claude Code (CLI)

```bash
claude mcp add pixmith --scope user -- node /path/to/Pixmith/src/index.js
```

Or add the same `mcpServers` block above to a project-level `.mcp.json`.

### Try it

> Use Pixmith to generate a 1536x1024 image of a lighthouse at sunset.

> Now make it a stormy night, keep the lighthouse exactly as it is.

---

## Troubleshooting

| Symptom                              | Cause / fix                                                                 |
|--------------------------------------|------------------------------------------------------------------------------|
| `[binary_missing]`                   | Codex CLI not found in `CODEX_BIN` or any of the usual locations — install it, or set `CODEX_BIN` to the correct path. Apps launched from the Dock don't see your shell's `PATH`, so use an absolute path. |
| `[not_signed_in]`                    | Sign in to Codex (ChatGPT account) or configure an API key, then retry.     |
| `[timeout]`                          | Large image or slow service — raise `PIXMITH_TIMEOUT_MS`.                    |
| `[usage_limit]`                      | Your ChatGPT plan's image/Codex limit was reached. Retry after it resets, or add credits. |
| `[credits_confirmation_needed]`      | The plan limit is used up and the job would run on paid credits. Tell the assistant whether to continue; see [plan usage and credits](#plan-usage-and-credits). |
| `[generation_failed]` / `[no_output]`| Codex ran but produced nothing; see the `Detail:` stderr tail in the error. |
| Windows: image isn't saved / sandbox error | Codex's OS sandbox is macOS/Linux only and blocks file writes on Windows. Pixmith bypasses it on Windows automatically (`PIXMITH_BYPASS_SANDBOX=true`). If you overrode that, unset it. |
| Client times out during generation | No call waits longer than the wait window (45s by default). If your client's request timeout is shorter than ~60s, lower `PIXMITH_POLL_WAIT_MS` to match. The job keeps running either way — call `get_image_result` with no arguments to collect it. |
| `[unknown_job]`                      | The job_id expired (>15 min) or nothing was started — call `generate_image` first. |
| `[bad_request]`                      | The `size` breaks a gpt-image-2 limit (see [size limits](#size-limits)), `output_dir` is not absolute, or an input image is missing, too large, or not a PNG/JPEG/WebP/GIF. Fix the argument and retry. |
| An edit changed more than asked      | Say explicitly what must stay the same ("change only X; keep Y unchanged"), and pass a fixed `size` if the framing moved. |
| Jobs sit at `status: queued`         | More jobs were started than `PIXMITH_MAX_CONCURRENT` allows. They run in order; raise the limit if your plan can take it. |

> **A note on timing.** A generation is an agent session, not a raw API call, so it
> takes ~30–40s (edits longer). Pixmith never blocks a call past the wait window: a
> typical image comes back from the first call, and anything slower returns a `job_id`
> that `get_image_result` collects with short, bounded waits.

---

## Security notes

- Pixmith never reads, prints, or commits Codex auth tokens (e.g. `~/.codex/auth.json`).
- `node_modules/`, generated images, and any `.env`/`auth.json`/key files are
  git-ignored.
- On macOS and Linux, Codex runs with the `workspace-write` sandbox scoped to the
  output directory. **On Windows there is no OS sandbox** (Codex's Seatbelt/Landlock
  sandboxing is Unix-only), so Pixmith runs Codex unsandboxed there by default. The
  agent is instructed not to run shell commands, but that is a prompt, not a policy.
- Input images for `edit_image` / `reference_images` must be absolute paths to real image
  files (checked by magic bytes, max 20 MB). They are attached to the Codex prompt, so
  they are uploaded to OpenAI as part of the request; the files themselves are never
  modified.
- `output_dir` must be an absolute path; relative paths are rejected so the MCP
  client's working directory never decides where files land.

## License

[MIT](LICENSE).
