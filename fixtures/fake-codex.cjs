#!/usr/bin/env node
// A stand-in for the Codex CLI, used by test/generate.test.js. Kept outside test/ so older
// Node test runners, which execute every file under that folder, skip it. It mimics the
// parts of `codex exec` that Pixmith relies on; FAKE_MODE picks the behaviour.
const fs = require("node:fs");
const path = require("node:path");

const SESSION = "0a0b0c0d-1111-2222-3333-444455556666";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 4, 0, 0, 0, 3, 0]), // 1024 x 768
  Buffer.alloc(64, 0),
]);

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
const home = process.env.CODEX_HOME;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const writePng = () => {
  const dir = path.join(home, "generated_images", SESSION);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "exec-1.png"), PNG);
};

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(home, "last-call.json"), JSON.stringify({ args, stdin }));
  const lastMsg = args[args.indexOf("--output-last-message") + 1];

  if (mode === "nojson") {
    if (args.includes("--json")) {
      process.stderr.write("error: unexpected argument '--json' found\n");
      process.exit(2);
    }
    process.stderr.write(`OpenAI Codex\nsession id: ${SESSION}\n`);
    writePng();
    fs.writeFileSync(lastMsg, "DONE");
    process.stdout.write("DONE\n");
    return;
  }

  emit({ type: "thread.started", thread_id: SESSION });
  emit({ type: "turn.started" });
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "limit") {
    emit({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 2 hours." } });
    process.exit(1);
  }
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Generating one image." } });
  if (mode === "refuse") {
    emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ERROR: content policy" } });
    fs.writeFileSync(lastMsg, "ERROR: content policy");
    return;
  }
  writePng();
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "DONE" } });
  emit({ type: "turn.completed", usage: {} });
  fs.writeFileSync(lastMsg, "DONE");
});
