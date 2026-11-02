# Asset specs

Sizes, formats and placement for common project images. Run `fit-image.mjs suggest <target>` for the size to generate. The "Generate" column shows what it currently picks.

## Contents
- [Website icons](#website-icons)
- [Social and link previews](#social-and-link-previews)
- [Page images](#page-images)
- [Apps and stores](#apps-and-stores)
- [Other](#other)
- [Head tags](#head-tags)
- [Where files go, by framework](#where-files-go-by-framework)

## Website icons

| File | Size | Notes | Generate |
| --- | --- | --- | --- |
| `favicon.ico` | 16, 32, 48 in one file | Browsers request `/favicon.ico` at the site root by default. `ico raw.png favicon.ico --sizes 16,32,48` | `1024x1024` |
| `icon-192.png`, `icon-512.png` | 192x192, 512x512 | Web app manifest icons. Transparency allowed. | `1024x1024` |
| `icon-maskable-512.png` | 512x512 | Manifest icon with `"purpose": "maskable"`. Full-bleed background; keep the symbol inside the central circle of 80% of the width, because platforms crop to their own shapes. Use `fit --mode contain --background` on a cutout, with the symbol scaled down first if needed. | `1024x1024` |
| `apple-touch-icon.png` | 180x180 | Must be opaque: iOS fills transparency with black. iOS rounds the corners itself. | `1024x1024` |

Icon design: one simple, bold shape with strong contrast; no thin lines, fine detail or words. Check the 16 and 32 pixel versions by eye.

## Social and link previews

| Asset | Size | Notes | Generate |
| --- | --- | --- | --- |
| Open Graph image (`og:image`) | 1200x630 | Used by Facebook, LinkedIn, Slack, Discord, iMessage and others. PNG or JPEG, ideally under 1 MB. The URL must be absolute. Keep text and the subject in the centre, since some apps crop the sides. | `1392x736` |
| X / Twitter card | 1200x630 works | With `twitter:card` set to `summary_large_image`, X uses `og:image` when there is no `twitter:image`. | as above |
| GitHub social preview | 1280x640 | Not set from code: the user uploads it under the repository's Settings > General > Social preview. PNG or JPEG under 1 MB. | `1440x720` |

## Page images

| Asset | Size | Notes |
| --- | --- | --- |
| Full-width hero | 1920x1080, plus 1280x720 for smaller screens | JPEG at quality 80 to 85 for photos. Leave calm space where the headline sits. |
| Blog or article header | 1600x900 | 16:9; most themes crop it, so centre the subject. |
| README banner | 1280x320 to 1280x640 | Store it in the repo (`assets/` or `.github/`) and reference it with a relative path. GitHub shows READMEs at about 900 pixels wide, so 1280 stays sharp on high-density screens. Banners wider than 3:1 must be generated at 3:1 and cropped. |
| Email header | 1200 wide, shown at 600 | Many email clients block images, so the email must work without it. |

## Apps and stores

| Asset | Size | Notes |
| --- | --- | --- |
| iOS App Store icon | 1024x1024 | PNG with no transparency and square corners; the system applies the mask. |
| Google Play icon | 512x512 | 32-bit PNG, under 1 MB. |
| Google Play feature graphic | 1024x500 | JPEG or 24-bit PNG with no transparency. |
| YouTube thumbnail | 1280x720 | Under 2 MB. |

## Other

- **Game textures:** power-of-two sizes (512, 1024, 2048). Ask for "seamless tileable texture, no focal point, even lighting", but check the tiling yourself: the model doesn't guarantee seamless edges.
- **Sprites and stickers:** generate on a transparent or flat key-colour background (see the transparency steps in SKILL.md), then `fit --mode contain` to the sprite size.

## Head tags

For a plain HTML site, inside `<head>`. Use the real title, description and absolute base URL.

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:title" content="Site title">
<meta property="og:description" content="One sentence about the site.">
<meta property="og:url" content="https://example.com/">
<meta property="og:image" content="https://example.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="What the image shows">
<meta name="twitter:card" content="summary_large_image">
```

Web manifest icons:

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

## Where files go, by framework

| Project | Static files | Notes |
| --- | --- | --- |
| Plain HTML, Vite, Create React App, Astro, Remix | `public/` (or the site root) | Add the head tags to `index.html` or the shared layout. |
| Next.js App Router | `app/` file conventions | `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`, `app/opengraph-image.png` with `app/opengraph-image.alt.txt`, `app/twitter-image.png`. Next.js writes the tags itself. Set `metadataBase` in the root layout so image URLs are absolute. |
| Next.js Pages Router | `public/` | Tags in `pages/_document` or via `next/head`. |
| SvelteKit, Hugo, Gatsby | `static/` | Tags in `app.html` (SvelteKit) or the base layout. |
| Docusaurus | `static/img/` | Set `favicon` and `themeConfig.image` (the social card) in `docusaurus.config`. |
| Jekyll | site root or `assets/` | Tags in `_includes/head.html` or the default layout. |
| README / docs | `assets/` or `.github/` | Relative paths, e.g. `<img src="assets/banner.png" alt="…" width="100%">`. |

For anything else, find where the project already keeps images and follow that.
