import { promises as fs } from "node:fs";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

// MCP clients cap the size of a tool result — Claude Desktop rejects anything
// over 1 MB — and a gpt-image-2 PNG is 2-3 MB (4 MB once base64-encoded). So
// the full-resolution PNG stays on disk, and what travels inline is a JPEG
// preview that fits the budget. Pure JavaScript on purpose: no native modules,
// identical behaviour on macOS, Windows and Linux.

/** Long-edge sizes tried in order until the preview fits. */
const LONG_EDGES = [2048, 1536, 1280, 1024, 768, 512, 384];
const QUALITIES = [85, 72];

/** Composite RGBA over white into a new RGBA buffer (JPEG has no alpha). */
function flatten(src) {
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    out[i] = Math.round(src[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(src[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(src[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** Area-average downscale of an RGBA buffer. Good quality for shrinking, and simple. */
export function downscale(src, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor(dy * yr);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((dy + 1) * yr)));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor(dx * xr);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((dx + 1) * xr)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y += 1) {
        let i = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x += 1, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (dy * dw + dx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Produce the inline version of a PNG within `budgetBytes` (raw bytes, before
 * base64). Returns
 *   { data: Buffer, mimeType, width, height, preview: boolean }
 * where `preview` is false when the original PNG already fits and is returned
 * untouched, or null when nothing could be produced within the budget.
 */
export async function makeInlineImage(pngPath, budgetBytes) {
  const original = await fs.readFile(pngPath);
  if (original.length <= budgetBytes) {
    return { data: original, mimeType: "image/png", width: null, height: null, preview: false };
  }

  const png = PNG.sync.read(original);
  const flat = flatten(png.data);
  const longEdge = Math.max(png.width, png.height);
  const edges = [...new Set([longEdge, ...LONG_EDGES.filter((e) => e < longEdge)])];

  for (const edge of edges) {
    const scale = edge / longEdge;
    const w = Math.max(1, Math.round(png.width * scale));
    const h = Math.max(1, Math.round(png.height * scale));
    const pixels = scale === 1 ? flat : downscale(flat, png.width, png.height, w, h);
    for (const quality of QUALITIES) {
      const { data } = jpeg.encode({ data: pixels, width: w, height: h }, quality);
      if (data.length <= budgetBytes) {
        return { data, mimeType: "image/jpeg", width: w, height: h, preview: true };
      }
    }
  }
  return null;
}
