---
name: project-images
description: Make images for a codebase or repo at exact specs with Pixmith, then crop and resize them to precise pixel sizes, build favicon.ico files and transparent cutouts, save them where the project keeps its assets, and wire them into the HTML, framework metadata, web manifest or README. Use this whenever the user wants an image for their website, web app, mobile app, game, docs or README, such as a favicon, app icon, Open Graph or social preview card, hero image, README banner, blog header, illustration, sprite or texture, even if they only say "add a favicon" or "we need an og image". Pair it with the image-prompts skill for writing the prompt itself.
---

# Project images with Pixmith

Project assets have hard requirements that a raw generation doesn't meet. A social card must be exactly 1200x630. A favicon needs several sizes in one `.ico` file. An app icon can't have transparency. gpt-image-2 only renders certain sizes and doesn't always return the size it was asked for. So the workflow is: generate at a size the model accepts, then use the bundled script to cut the result to the exact spec, and finally wire it into the project.

Write each prompt with the image-prompts skill. This skill covers everything around the prompt.

## The script

`scripts/fit-image.mjs` sits in this skill's directory; the base directory is shown when the skill loads. Run it with `node`. Every command prints one line of JSON.

```bash
node <skill-dir>/scripts/fit-image.mjs suggest 1200x630                 # size to generate for a target
node <skill-dir>/scripts/fit-image.mjs fit raw.png public/og.png --size 1200x630
node <skill-dir>/scripts/fit-image.mjs fit raw.png hero.jpg --size 1920x1080 --gravity top --quality 85
node <skill-dir>/scripts/fit-image.mjs fit logo.png icon.png --size 512x512 --mode contain --background "#0b3954"
node <skill-dir>/scripts/fit-image.mjs ico raw.png public/favicon.ico --sizes 16,32,48
node <skill-dir>/scripts/fit-image.mjs key-out raw.png cutout.png --color "#00ff00"
node <skill-dir>/scripts/fit-image.mjs info public/og.png
```

- `fit --mode cover` (the default) crops to the target ratio and then scales, so nothing is distorted. `--gravity` picks which part survives the crop. `--mode contain` scales the whole image to fit and pads the rest with `--background`, or with transparency if no background is given.
- The output format follows the extension: `.png`, or `.jpg`/`.jpeg` for photos where file size matters. The script doesn't write WebP or AVIF; if the project wants those, use its build tooling.
- If `node` reports that it cannot find `pngjs`, the skill was copied outside the Pixmith plugin. Fall back to `sips` on macOS, ImageMagick (`magick`), or Python Pillow, and keep the same steps.

## Workflow

1. **Learn the project's conventions.** Find the framework and where static files live: `public/` for Vite, Astro and most static sites; `app/` file conventions for the Next.js App Router; `static/` for Hugo and SvelteKit; an `assets/` or `.github/` folder for a README. Look for existing icons, `<link rel="icon">`, `og:image`, a web manifest (`site.webmanifest`, `manifest.json`) and framework metadata, so new files replace or complement what is there instead of duplicating it.
2. **Get the spec.** [references/asset-specs.md](references/asset-specs.md) lists sizes, formats and placement rules for common assets, plus the head tags and framework file names. If the user gave a size, it wins.
3. **Pick the generation size.** Run `suggest` with the target size and pass its `generate` value as `size` to `generate_image`. It matches the target's shape within the model's limits, and small icons get rendered large and scaled down, which looks much better than rendering small.
4. **Write the prompt for the final use.** Besides the image-prompts guidance, say what the crop and display will do to it. Cards and banners need the subject centred, with margin all round, because the crop takes the edges. Icons need one bold, simple shape that still reads at 16 pixels: no fine detail, no thin lines, and no text unless it's one or two letters.
5. **Generate.** Don't pass `output_dir`, so raw renders stay in Pixmith's own folder; the project only needs the finished files, and raw renders are large. Pass a `filename` such as `tidepool-icon-raw` so the render is easy to find again.
6. **Review the result** in the inline image before processing. Iterate with `edit_image` while it's still a single large image; that's much cheaper than redoing all the derived files.
7. **Produce the final files** with `fit`, `ico` and `key-out`, written straight to their destinations in the project, using the project's existing names when replacing files.
8. **Wire them in.** Update the HTML head, framework metadata, web manifest or README so every new file is actually referenced, and remove references to files you replaced. Open Graph image URLs must be absolute (`https://…`): use the site's base URL from the project's config, or ask the user if you can't find it.
   For the 16 and 32 pixel favicon sizes, crop in on the symbol first (`fit` the render to a tighter square, then `ico` from that), so the mark fills the tiny icon instead of shrinking into its padding.
9. **Verify.** Run `info` on each final file to confirm its exact size, and check that every path you referenced exists. For icons, look at the small sizes yourself. Scale the 32-pixel version up with `fit … --size 256x256` and view it, to confirm the shape still reads.
10. **Report** the files you created or replaced, with their sizes, the references you changed, and anything the user must do outside the code, such as uploading a GitHub social preview in the repository settings.

If a file already exists at a destination, say that you're replacing it. Git keeps the old version when the file is tracked; when it isn't, keep a copy next to it as `<name>.bak.<ext>`.

## Transparent images

Logos, icons, stickers and sprites often need a transparent background.

1. Pass `background: "transparent"` to `generate_image` and describe the subject alone, with no backdrop, floor or shadow. Pixmith's result says whether the PNG came back with an alpha channel; `info` on the file confirms it and reports `transparent_percent`.
2. If the result is opaque, generate on a flat key colour instead: "on a solid, flat, pure #00FF00 green background, no shadow, no gradient, no floor". Choose a key colour the subject doesn't contain; use magenta `#FF00FF` for green subjects. Then run `key-out --color "#00ff00"`.
3. Check the cutout's edges on a dark background, because halos show there. Use `fit cutout.png check.png --size 512x512 --mode contain --background "#222222"` and view it. If a coloured fringe remains, raise `--tolerance`. If parts of the subject vanished, lower it.

App store icons and the Apple touch icon must be opaque: iOS fills transparency with black. For those, `fit --mode contain --background "#rrggbb"` with a brand colour, or generate them full-bleed.

## Sets of assets

A favicon, touch icon, manifest icons and a social card for one site should share a look. Generate the icon design once at `1024x1024` and derive every icon size from that one render. Generate the social card separately, at its own shape, and pass the icon render as a reference image so the styles match.
