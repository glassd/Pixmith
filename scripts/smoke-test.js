#!/usr/bin/env node
// Direct engine smoke test: bypasses the MCP protocol and calls the generator.
// Usage: node scripts/smoke-test.js ["your prompt"] [size]
import { generateImage } from "../src/codex.js";

const prompt = process.argv[2] || "a red circle on a white background";
const size = process.argv[3] || "1024x1024";

console.error(`[smoke] generating: "${prompt}" @ ${size}`);
const t0 = Date.now();

try {
  const res = await generateImage({
    prompt,
    size,
    onProgress: (line) => console.error(`[codex] ${line}`),
  });
  console.error(`[smoke] done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(JSON.stringify(res, null, 2));
} catch (err) {
  console.error(`[smoke] FAILED: [${err.kind || "error"}] ${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exit(1);
}
