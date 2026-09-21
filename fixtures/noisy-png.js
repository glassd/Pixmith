import { PNG } from "pngjs";

/** A PNG full of noise: incompressible, so even a modest size makes a large file. */
export function noisyPng(width, height, { alpha = 255 } = {}) {
  const png = new PNG({ width, height });
  let seed = 12345;
  for (let i = 0; i < png.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    png.data[i] = seed & 0xff;
    png.data[i + 1] = (seed >> 8) & 0xff;
    png.data[i + 2] = (seed >> 16) & 0xff;
    png.data[i + 3] = alpha;
  }
  return PNG.sync.write(png);
}
