#!/usr/bin/env node
// Direct engine smoke test: bypasses the MCP protocol and calls the generator.
// Usage:
//   node scripts/smoke-test.js ["your prompt"] [size]
//   node scripts/smoke-test.js "make the sky purple" auto /abs/path/to/source.png   (edit)
import path from "node:path";

import { generateImage, STAGE_LABELS } from "../src/codex.js";

const prompt = process.argv[2] || "a red circle on a white background";
const editSource = process.argv[4] ? path.resolve(process.argv[4]) : null;
const size = process.argv[3] || (editSource ? "auto" : "1024x1024");

const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;
console.error(`[smoke] ${editSource ? `editing ${editSource}` : "generating"}: "${prompt}" @ ${size}`);

try {
  const res = await generateImage({
    prompt,
    size,
    mode: editSource ? "edit" : "generate",
    images: editSource ? [editSource] : [],
    onStage: (stage) => console.error(`[smoke] ${secs()} ${STAGE_LABELS[stage] || stage}`),
    onProgress: (line) => console.error(`[codex] ${line}`),
  });
  console.error(`[smoke] done in ${secs()}`);
  console.log(JSON.stringify(res, null, 2));
} catch (err) {
  console.error(`[smoke] FAILED: [${err.kind || "error"}] ${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exit(1);
}
