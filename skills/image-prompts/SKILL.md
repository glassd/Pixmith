---
name: image-prompts
description: Write the prompt that Pixmith sends to gpt-image-2, pick the right size, and refine results with targeted edits. Use this whenever you are about to call Pixmith's generate_image or edit_image tool, for any request to create, draw, render, design, illustrate, mock up or change a picture, photo, poster, logo, icon, banner, sticker, card, diagram or other image, even when the user's request is only a few words. Pixmith passes your prompt to the image model word for word and adds nothing of its own, so the prompt you write is the whole brief.
---

# Writing image prompts for Pixmith

Pixmith's `generate_image` and `edit_image` tools hand your prompt to gpt-image-2 exactly as written. Nothing in between expands a short request, so "a bakery banner" produces a generic bakery banner. A prompt that names the use, subject, style, composition, light and constraints produces the image the user had in mind.

Tool names vary by install (for example `mcp__pixmith__generate_image` or `mcp__plugin_pixmith_pixmith__generate_image`). This skill refers to them by their short names.

## Decide what kind of job it is

- **New image or edit?** Use `edit_image` only when the user wants to keep an existing image and change part of it. If they give images as inspiration ("in the style of this"), generate a new image and pass those files as `reference_images`. When they refer to an earlier image ("the fox picture from yesterday"), find its path with `list_images` and its `query` filter rather than guessing.
- **Ask, or proceed?** Ask only when a missing detail would make the result unusable, such as the exact wording of text that must appear, or a name. For everything else, choose sensible defaults, generate, and say briefly what you chose. A finished image the user can react to is more useful than a list of questions.
- **Check the facts first.** Read the user's details for contradictions before you write anything into the image: a date that doesn't fall on the weekday given, a misspelled name, numbers that don't add up. Keep their wording, and point out the problem in your reply so they can correct it before printing or publishing. Text baked into an image is the expensive kind to fix later.
- **How much to add.** If the user wrote a detailed description, keep their words and organise them; don't pile on your own creative ideas. If the request is vague, add the details that make a good image of that kind: framing, medium, lighting, mood. Don't invent things the user didn't imply, such as extra characters, props, brand colours, slogans or a story.

## Prompt shape

Use short labelled lines in this order, and leave out any line that doesn't apply. The model follows a compact spec more reliably than a long paragraph, and labelled lines are easy to adjust for the next attempt.

```text
Asset: <what it is and where it will be used>
Subject: <the main subject, with the details that matter>
Scene: <setting or backdrop>
Style: <medium and finish: photo, watercolour, flat vector illustration, 3D render...>
Composition: <framing, viewpoint, placement, empty space for copy>
Lighting and mood: <light source, time of day, atmosphere>
Palette: <colours, if they matter>
Text (verbatim): "<exact words>", <typeface style, weight, colour, placement>
Constraints: <what must be true: no watermark, no logos, keep subject centred...>
```

**Example.** The user asks: "make me a banner for my bakery's website, it's called Crumb & Co."

```text
Asset: website hero banner for an artisan bakery
Subject: a rustic wooden counter with fresh sourdough loaves, croissants and a few scattered flour dustings
Scene: warm, softly blurred bakery interior in the background
Style: photorealistic food photography, shallow depth of field
Composition: wide landscape; bread grouped on the right third; calm, uncluttered space on the left for the site's headline
Lighting and mood: soft morning window light from the left, warm and inviting
Text (verbatim): "Crumb & Co." in an elegant serif, cream colour, placed in the empty left area
Constraints: no other text, no logos, no watermark
```

Size `1536x1024`. A website banner would usually carry its headline as HTML text rather than in the image. If that's likely, leave the Text line out and keep the empty space, then mention that choice to the user.

## Style notes

- **Photos:** write `photorealistic` and use camera language: lens ("35mm", "macro"), depth of field, angle, light. Ask for real texture (wood grain, fabric weave, skin pores) so it doesn't look like a plastic render.
- **Illustration:** name the medium (watercolour, gouache, flat vector, linocut, pixel art) and the line and colour treatment. "Children's book watercolour, soft edges, muted palette" beats "cute illustration".
- **Logos and icons:** ask for a simple, bold silhouette on a plain background, flat colour, generous margin, no gradients or mock-up scene. Say if it must work small. Pixmith produces PNG files, not vector, so if the user needs SVG, tell them the result is a raster concept they would need to trace.
- **UI mock-ups and wireframes:** state the fidelity first (low-fi grayscale wireframe, or polished mock-up), then list the sections in order.
- **Diagrams and infographics:** give the real labels and data, the reading order, and ask for clean readable type. Keep the amount of text small; long passages come out garbled.

## Text in images

- Put the exact words in quotes and describe the type: style, weight, colour, placement.
- Keep text short: a headline, a name, a date. Every extra word is another chance for a spelling error.
- Build headlines from the user's own facts ("Maya's 7th Birthday") rather than adding slogans or taglines they didn't ask for. If you think a tagline would help, offer it in your reply instead of putting it in the image.
- Spell unusual names letter by letter ("Kaïa: K-A-Ï-A") and add "no other text".
- After the image comes back, read the text in it. If anything is misspelled, fix it with `edit_image` ("Correct the headline to read exactly "…"; change nothing else").

## Choosing a size

| Use | Size |
| --- | --- |
| Default, social posts, avatars, icons, logos (fastest) | `1024x1024` |
| Landscape: banners, blog headers, slides, desktop wallpaper | `1536x1024` (or `2048x1152` for 16:9) |
| Portrait: posters, flyers, book covers | `1024x1536` |
| Phone wallpaper, stories | `1152x2048` |
| Very wide strip (3:1 at most) | `2304x768` |
| Large prints, 4K | `3840x2160` or `2160x3840` |

The rules: each edge a multiple of 16, longest edge at most 3840, ratio at most 3:1, and between about 0.66 and 8.3 megapixels. Pixmith rejects anything else up front. Bigger images take longer and use more of the plan. The model doesn't always return exactly the requested size (a `1024x1024` request can come back as `1254x1254`), and the result reports the real size. When an asset needs exact pixels, such as a favicon or a 1200x630 social card, use the project-images skill, which crops and resizes to spec.

## Reference images

`reference_images` takes up to 4 absolute file paths. They are numbered in order, and with `edit_image` the image being edited is Image 1 and references follow. Say what each one is for, because the model doesn't otherwise know which aspects to borrow:

```text
Image 2 (style reference): match its colour palette and loose ink linework; do not copy its subject or layout.
```

## Edits

- Make one change per edit, and state what stays the same: "Change only the sky to a stormy purple. Keep the house, the garden, the framing and the lighting on the house unchanged."
- Repeat the things that must not change in every edit. Without that, small drift accumulates over several rounds.
- Edit the latest good result. Each finished result ends with the exact `edit_image` call for refining it, so start from that. If several edits have drifted, go back to an earlier version rather than piling on fixes.
- `size` defaults to `auto` for edits, which keeps the source's aspect ratio. Leave it unless the user wants a different shape.

## After each result

Pixmith returns the image inline, so look at it before you reply. Check the subject, count, text spelling, style, composition and constraints against what the user asked for.

- **Describe what is actually there.** Write your description from the image, not from your prompt. The model sometimes drops or swaps details, such as a mug that became a vase, and a description copied from the prompt would tell the user something false.
- **Fix misses that affect the use.** If a miss would stop the image working for its purpose, fix it with one targeted edit before replying. Examples: no room left for the headline, misspelled text, the wrong shape. For smaller differences, mention them and offer the edit.
- **Give the full saved path** (the `Path` line from the result), not just a file name.

## Several images

- **Alternatives of one idea:** pass `variants` (2 to 4) with a single prompt. Each variant is a full generation against the plan.
- **Different ideas:** write genuinely different prompts (different composition or style) and start each with `wait: false`, then collect each with `get_image_result` and its `job_id`. Pixmith runs one job at a time by default, and every image uses part of the user's ChatGPT plan, so check with the user before making more than about four in total.
- **Names:** pass `filename` (e.g. `crumb-hero`) when the image is a deliverable, so the user gets a meaningful file instead of one named after the prompt.
- **A matching set** (icons, characters across scenes, a series of illustrations): make one anchor image first and get the user's approval. Then generate the rest with the anchor in `reference_images` and a line like "same style, palette and line weight as Image 1". Keep the shared style lines identical in every prompt.

## Limits to keep in mind

- **Transparency:** pass `background: "transparent"` for logos, icons and stickers, and describe the subject alone with no backdrop, floor or shadow. The model doesn't always comply, and the result says whether the PNG really has an alpha channel. If it doesn't, retry once, or use the project-images skill to remove a flat background. The inline preview shows transparent areas as white; the PNG on disk keeps them.
- **Plan usage:** results include a plan-usage line. If Pixmith reports that the plan limit is used up and asks for confirmation to use paid credits, ask the user. Only set `use_credits: true` after they explicitly agree.
- **Refusals:** if a generation is refused, rephrase toward what the user actually needs instead of retrying the same prompt.
- **Setup problems:** if Pixmith reports that Codex is missing or signed out, or calls keep failing, run `pixmith_status`. It checks the setup without using any plan quota and says what to fix.
