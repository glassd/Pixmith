#!/usr/bin/env node
// fit-image.mjs: exact-size image utilities for project assets made with Pixmith.
//
// gpt-image-2 only produces certain sizes (multiples of 16, ratio <= 3:1, ...)
// and does not always return exactly the size it was asked for. Real assets
// need exact pixels: a 1200x630 social card, a 180x180 touch icon, a
// multi-size favicon.ico. This script bridges the gap. Pure JavaScript (pngjs,
// jpeg-js), so it behaves the same on macOS, Windows and Linux.
//
//   suggest <WxH>                         best gpt-image-2 size to generate for a target
//   fit <in> <out> --size WxH [--mode cover|contain] [--gravity center|top|bottom|left|right]
//                  [--background #rrggbb|transparent] [--quality 1-100]
//   ico <in> <out.ico> [--sizes 16,32,48]
//   key-out <in> <out.png> [--color auto|#rrggbb] [--tolerance 40] [--softness 40]
//   info <file>
//
// Inputs: PNG or JPEG. Outputs: PNG, or JPEG when <out> ends in .jpg/.jpeg.
// Every command prints one JSON object on stdout.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

// ---- gpt-image-2 size rules --------------------------------------------------------

export const LIMITS = Object.freeze({ step: 16, maxEdge: 3840, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 });

/** The sizes gpt-image-2 is most used at; preferred when they fit the target equally well. */
const POPULAR = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840",
];

function validGenerationSize(w, h) {
  const { step, maxEdge, maxRatio, minPixels, maxPixels } = LIMITS;
  return (
    w % step === 0 &&
    h % step === 0 &&
    w <= maxEdge &&
    h <= maxEdge &&
    Math.max(w, h) / Math.min(w, h) <= maxRatio &&
    w * h >= minPixels &&
    w * h <= maxPixels
  );
}

/**
 * Pick the size to ask gpt-image-2 for, given the exact size the asset needs.
 * Matches the target's aspect ratio as closely as the rules allow, covers the
 * target in both dimensions when possible, and otherwise stays small (smaller
 * renders faster). Never below ~1 megapixel, which is where the model does its
 * best work, so small icons are generated large and downscaled.
 */
export function suggestGenerationSize(tw, th) {
  const target = Math.log(tw / th);
  const clamped = Math.max(-Math.log(LIMITS.maxRatio), Math.min(Math.log(LIMITS.maxRatio), target));
  const preferPixels = Math.max(1024 * 1024, tw * th);
  const candidates = [];
  for (let w = 256; w <= LIMITS.maxEdge; w += LIMITS.step) {
    for (const h of [Math.floor(w / Math.exp(clamped) / 16) * 16, Math.ceil(w / Math.exp(clamped) / 16) * 16]) {
      if (h > 0 && validGenerationSize(w, h)) candidates.push({ w, h, err: Math.abs(Math.log(w / h) - clamped) });
    }
  }
  const bestErr = Math.min(...candidates.map((c) => c.err));
  const close = candidates.filter((c) => c.err <= bestErr + 0.01);
  const covering = close.filter((c) => c.w >= tw && c.h >= th && c.w * c.h >= preferPixels * 0.95);
  const smallest = covering.length ? covering.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b)) : null;
  // A familiar size may be up to 25% larger than the smallest covering size.
  const popularLimit = smallest ? smallest.w * smallest.h * 1.25 : 0;
  const popular = covering
    .filter((c) => POPULAR.includes(`${c.w}x${c.h}`) && c.w * c.h <= popularLimit)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  const pick = popular ?? smallest ?? close.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const notes = [];
  if (Math.abs(target - clamped) > 1e-9) notes.push(`target ratio is beyond 3:1, so generate at 3:1 and crop`);
  if (pick.w < tw || pick.h < th)
    notes.push(`target is larger than gpt-image-2 can render; the result will be upscaled`);
  // The model rarely returns exactly the size it was asked for, so the result
  // always goes through `fit` to land on the target pixels.
  return {
    generate: `${pick.w}x${pick.h}`,
    target: `${tw}x${th}`,
    next: `fit <result.png> <out> --size ${tw}x${th}`,
    notes,
  };
}

// ---- decode / encode ---------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export async function readImage(file) {
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 4).equals(PNG_MAGIC)) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data), format: "png" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: Buffer.from(img.data), format: "jpeg" };
  }
  throw new Error(`${file}: not a PNG or JPEG file`);
}

function isOpaque(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

function flattenOver(data, [br, bg, bb]) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + br * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a + bg * (1 - a));
    out[i + 2] = Math.round(data[i + 2] * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  // Opaque images are written as RGB: a third smaller, and no stray alpha channel.
  return PNG.sync.write(png, { colorType: isOpaque(img.data) ? 2 : 6 });
}

export async function writeImage(file, img, { quality = 88, background = [255, 255, 255] } = {}) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const ext = path.extname(file).toLowerCase();
  let buf;
  if (ext === ".jpg" || ext === ".jpeg") {
    buf = jpeg.encode({ data: flattenOver(img.data, background), width: img.width, height: img.height }, quality).data;
  } else if (ext === ".png") {
    buf = encodePng(img);
  } else {
    throw new Error(
      `${file}: output must end in .png, .jpg or .jpeg (convert to WebP/AVIF with your build tooling if needed)`,
    );
  }
  await fs.writeFile(file, buf);
  return buf.length;
}

// ---- resampling ---------------------------------------------------------------------

/**
 * Taps for resampling the source interval [start, start+len) onto n samples:
 * exact box coverage when shrinking (sharp, no aliasing), linear when enlarging.
 */
function taps(srcSize, start, len, n) {
  const scale = len / n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = [];
    if (scale >= 1) {
      const a = start + i * scale;
      const b = a + scale;
      for (let s = Math.max(0, Math.floor(a)); s < Math.min(srcSize, Math.ceil(b)); s += 1) {
        const w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 0) t.push([s, w]);
      }
    } else {
      const c = Math.min(srcSize - 1, Math.max(0, start + (i + 0.5) * scale - 0.5));
      const s0 = Math.floor(c);
      const s1 = Math.min(srcSize - 1, s0 + 1);
      const f = c - s0;
      t.push([s0, 1 - f]);
      if (f > 0) t.push([s1, f]);
    }
    const sum = t.reduce((acc, [, w]) => acc + w, 0) || 1;
    out.push(t.map(([s, w]) => [s, w / sum]));
  }
  return out;
}

/** Resample rect {x,y,w,h} of an RGBA image to dw x dh. Premultiplied alpha, so edges don't fringe. */
export function resample(img, rect, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    pre[i] = data[i] * a;
    pre[i + 1] = data[i + 1] * a;
    pre[i + 2] = data[i + 2] * a;
    pre[i + 3] = data[i + 3];
  }
  const tx = taps(sw, rect.x, rect.w, dw);
  const ty = taps(sh, rect.y, rect.h, dh);
  // Horizontal pass: every source row -> dw columns.
  const mid = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const o = (y * dw + x) * 4;
      for (const [s, w] of tx[x]) {
        const i = (y * sw + s) * 4;
        mid[o] += pre[i] * w;
        mid[o + 1] += pre[i + 1] * w;
        mid[o + 2] += pre[i + 2] * w;
        mid[o + 3] += pre[i + 3] * w;
      }
    }
  }
  // Vertical pass, then un-premultiply.
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (const [s, w] of ty[y]) {
        const i = (s * dw + x) * 4;
        r += mid[i] * w;
        g += mid[i + 1] * w;
        b += mid[i + 2] * w;
        a += mid[i + 3] * w;
      }
      const o = (y * dw + x) * 4;
      const k = a > 0 ? 255 / a : 0;
      out[o] = Math.min(255, Math.round(r * k));
      out[o + 1] = Math.min(255, Math.round(g * k));
      out[o + 2] = Math.min(255, Math.round(b * k));
      out[o + 3] = Math.min(255, Math.round(a));
    }
  }
  return { width: dw, height: dh, data: out };
}

// ---- operations ---------------------------------------------------------------------

export function parseSize(s) {
  const m = String(s ?? "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,5})\s*[x×*]\s*(\d{1,5})$/);
  if (!m || +m[1] < 1 || +m[2] < 1) throw new Error(`invalid size "${s}"; use WIDTHxHEIGHT, e.g. 1200x630`);
  return { w: +m[1], h: +m[2] };
}

export function parseColor(s) {
  const m = String(s)
    .trim()
    .match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`invalid colour "${s}"; use #rrggbb`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const GRAVITY = new Set(["center", "top", "bottom", "left", "right"]);

function offset(free, gravity, startSide, endSide) {
  if (gravity === startSide) return 0;
  if (gravity === endSide) return free;
  return free / 2;
}

/** Cover: crop to the target ratio, then scale. Contain: scale to fit, then pad. */
export function fit(img, tw, th, { mode = "cover", gravity = "center", background = null } = {}) {
  if (!GRAVITY.has(gravity)) throw new Error(`invalid gravity "${gravity}"`);
  const { width: sw, height: sh } = img;
  if (mode === "cover") {
    const ta = tw / th;
    let cw = sw;
    let ch = sh;
    if (sw / sh > ta) cw = sh * ta;
    else ch = sw / ta;
    const rect = {
      x: offset(sw - cw, gravity, "left", "right"),
      y: offset(sh - ch, gravity, "top", "bottom"),
      w: cw,
      h: ch,
    };
    return resample(img, rect, tw, th);
  }
  if (mode !== "contain") throw new Error(`invalid mode "${mode}"; use cover or contain`);
  const scale = Math.min(tw / sw, th / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const inner = resample(img, { x: 0, y: 0, w: sw, h: sh }, dw, dh);
  const out = Buffer.alloc(tw * th * 4);
  if (background) {
    for (let i = 0; i < out.length; i += 4) {
      out[i] = background[0];
      out[i + 1] = background[1];
      out[i + 2] = background[2];
      out[i + 3] = 255;
    }
  }
  const ox = Math.round(offset(tw - dw, gravity, "left", "right"));
  const oy = Math.round(offset(th - dh, gravity, "top", "bottom"));
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const i = (y * dw + x) * 4;
      const o = ((y + oy) * tw + (x + ox)) * 4;
      // Straight-alpha "over": blend against the canvas only as far as the
      // canvas itself is opaque, so padding with transparency keeps colours.
      const a = inner.data[i + 3] / 255;
      const b = out[o + 3] / 255;
      const oa = a + b * (1 - a);
      for (let c = 0; c < 3; c += 1) {
        out[o + c] = oa > 0 ? Math.round((inner.data[i + c] * a + out[o + c] * b * (1 - a)) / oa) : 0;
      }
      out[o + 3] = Math.round(255 * oa);
    }
  }
  return { width: tw, height: th, data: out };
}

/** Pack PNG-encoded square images into an .ico (PNG entries are supported by every current browser and OS). */
export function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offsetBytes = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offsetBytes, o + 12);
    offsetBytes += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

/** Median colour of the image border: the background of a flat-backdrop render. */
export function borderColor(img) {
  const { width: w, height: h, data } = img;
  const ch = [[], [], []];
  const take = (x, y) => {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c += 1) ch[c].push(data[i + c]);
  };
  for (let x = 0; x < w; x += 1) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 1; y < h - 1; y += 1) {
    take(0, y);
    take(w - 1, y);
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}

/**
 * Make a flat background transparent. Pixels within `tolerance` of the key
 * colour become clear, pixels beyond tolerance+softness stay opaque, and the
 * band between gets partial alpha with the key colour un-mixed from it, so
 * anti-aliased edges don't keep a coloured halo.
 */
export function keyOut(img, { color = null, tolerance = 40, softness = 40 } = {}) {
  const key = color ?? borderColor(img);
  const out = Buffer.from(img.data);
  let clear = 0;
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.hypot(out[i] - key[0], out[i + 1] - key[1], out[i + 2] - key[2]);
    const a = d <= tolerance ? 0 : d >= tolerance + softness ? 1 : (d - tolerance) / softness;
    if (a === 0) clear += 1;
    if (a > 0 && a < 1) {
      for (let c = 0; c < 3; c += 1)
        out[i + c] = Math.max(0, Math.min(255, Math.round((out[i + c] - (1 - a) * key[c]) / a)));
    }
    out[i + 3] = Math.round(out[i + 3] * a);
  }
  return {
    image: { width: img.width, height: img.height, data: out },
    key,
    clearPercent: +((100 * clear) / (out.length / 4)).toFixed(1),
  };
}

export function describe(img) {
  let transparent = 0;
  let partial = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] === 0) transparent += 1;
    else if (img.data[i] < 255) partial += 1;
  }
  const n = img.data.length / 4;
  return {
    width: img.width,
    height: img.height,
    size: `${img.width}x${img.height}`,
    has_alpha: transparent + partial > 0,
    transparent_percent: +((100 * transparent) / n).toFixed(1),
  };
}

// ---- CLI ----------------------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--"))
      opts[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? "true" : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opts };
}

export async function run(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const need = (n, usage) => {
    if (pos.length < n) throw new Error(`usage: fit-image.mjs ${usage}`);
  };

  if (cmd === "suggest") {
    need(1, "suggest <WxH>");
    const { w, h } = parseSize(pos[0]);
    return suggestGenerationSize(w, h);
  }
  if (cmd === "info") {
    need(1, "info <file>");
    const img = await readImage(pos[0]);
    const st = await fs.stat(pos[0]);
    return { file: path.resolve(pos[0]), format: img.format, bytes: st.size, ...describe(img) };
  }
  if (cmd === "fit") {
    need(
      2,
      "fit <in> <out> --size WxH [--mode cover|contain] [--gravity center|top|bottom|left|right] [--background #rrggbb|transparent]",
    );
    const { w, h } = parseSize(opts.size);
    const img = await readImage(pos[0]);
    const background = !opts.background || opts.background === "transparent" ? null : parseColor(opts.background);
    const out = fit(img, w, h, { mode: opts.mode ?? "cover", gravity: opts.gravity ?? "center", background });
    const bytes = await writeImage(pos[1], out, {
      quality: opts.quality ? +opts.quality : 88,
      background: background ?? [255, 255, 255],
    });
    return { file: path.resolve(pos[1]), from: `${img.width}x${img.height}`, ...describe(out), bytes };
  }
  if (cmd === "ico") {
    need(2, "ico <in> <out.ico> [--sizes 16,32,48]");
    const sizes = (opts.sizes ?? "16,32,48").split(",").map((s) => +s.trim());
    if (sizes.some((s) => !Number.isInteger(s) || s < 1 || s > 256))
      throw new Error("--sizes must be integers from 1 to 256");
    const img = await readImage(pos[0]);
    const pngs = sizes.map((size) => ({ size, data: encodePng(fit(img, size, size, { mode: "cover" })) }));
    const buf = packIco(pngs);
    await fs.mkdir(path.dirname(path.resolve(pos[1])), { recursive: true });
    await fs.writeFile(pos[1], buf);
    return { file: path.resolve(pos[1]), sizes, bytes: buf.length, cropped_to_square: img.width !== img.height };
  }
  if (cmd === "key-out") {
    need(2, "key-out <in> <out.png> [--color auto|#rrggbb] [--tolerance 40] [--softness 40]");
    if (path.extname(pos[1]).toLowerCase() !== ".png")
      throw new Error("key-out output must be a .png (JPEG has no transparency)");
    const img = await readImage(pos[0]);
    const color = !opts.color || opts.color === "auto" ? null : parseColor(opts.color);
    const r = keyOut(img, {
      color,
      tolerance: opts.tolerance ? +opts.tolerance : 40,
      softness: opts.softness ? +opts.softness : 40,
    });
    const bytes = await writeImage(pos[1], r.image);
    const hex = `#${r.key.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    return { file: path.resolve(pos[1]), key_color: hex, cleared_percent: r.clearPercent, ...describe(r.image), bytes };
  }
  throw new Error("commands: suggest, fit, ico, key-out, info (see the header of this file)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
    .catch((err) => {
      process.stderr.write(`fit-image: ${err.message}\n`);
      process.exit(1);
    });
}
