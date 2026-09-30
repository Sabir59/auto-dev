# Home Screen — implementation package

Everything needed to build the **Home Screen** (AI visa assistant) without opening Figma. Source: Figma **Test Scripter** (`RKIFhesaX0XrNL37ULYLcP`), page **Main**, frame **Home Screen** (`12007:3717`), 422×672, read 2026-09-30.

| File | What's inside |
|---|---|
| `spec.json` | The whole spec: colours (each with the evidence for its token mapping), shadows, fonts, text styles with explicit line heights, icons, the screen tree with every measurement, and interactions (none are defined). |
| `icons/*.svg` | The 5 icons exactly as drawn in Figma, recoloured to `currentColor`. |
| `reference/home.png` | Figma's render at 1×. This is what "done" looks like. |
| `build/` | A reference HTML/CSS implementation written only from `spec.json` (`home.src.html` → `node build/build.mjs` inlines the icons → `home.html`). |
| `verify/` | Browser screenshot, pixel diff, and `verify.mjs` (re-checks the spec's claims against Figma and Google Fonts). |

## Read this first: the screen mixes two design systems
Part of it uses this file's design system (tokens, `DS/Button/*`, `Nav Tab`). Part of it predates it: a different palette, Inter and Georgia instead of the file's Newsreader / Plus Jakarta Sans, and an older blue `Button`. The package records what is actually there and **does not "fix" it silently**. `spec.json › colors` marks every value:
- `token`: equals a design-system variable exactly (use the token);
- `ambiguous`: several tokens share the value (pick by meaning);
- `raw`: off-palette (see the open questions).

Only the Send button's fill is actually *bound* to a variable in Figma.

## Things a developer would otherwise get wrong
- **Line heights.** Figma uses AUTO (the font's own) for most text, and browsers compute that differently. Use the explicit px in `spec.json › text` (e.g. headline 46/52, Inter 14/17).
- **Icon boxes.** Each SVG includes 1px stroke bleed per side: a 16px icon file is 18×18, a 22px one is 24×24. Place them with `margin: -1px`, or the icons shrink.
- **Icons are not Lucide.** They resemble Lucide `mic` / `send` / `house` / `book-open` / `user`, but side-by-side rendering against `lucide-static` shows different shapes. Use the SVGs here unless the designer confirms Lucide (see below).
- **Georgia:** load it from Google Fonts (`family=Georgia:ital,wght@0,700;1,700`). It's missing on Linux/Android, and the web font is metrically identical to the system one (measured).
- **Headline:** two lines stored as two nodes; line 2 is Bold Italic. Keep the break.
- **Borders count toward layout:** the Input Card's content sits at 21px (1px border + 20px padding), which is CSS `box-sizing: border-box`.

## Open questions for the designer
1. **Off-palette colours:** background `#f7f6f3`, text `#18181a` / `#78776f`, status orange `#d9790e`, and the blue Continue button `#3d4ee8`. None exists in the design system. Migrate them to tokens (e.g. `background`, `foreground`, `muted-foreground`, a warning token, `primary`)?
2. **Two button systems:** Continue uses the older `Button {Style=Primary}` (blue, Inter Bold 14), while Speak and Send use `DS/Button/*`. Should Continue be a `DS/Button/Primary`?
3. **Bottom nav overflows** the frame by 10px (it ends at y=682 in a 672px frame), so Figma clips its bottom padding and border. In code, anchor it to the bottom safe area instead.
4. **"Profile" tab** is a plain frame copying `Nav Tab {State=Inactive}`, not an instance. Use the component.
5. **Icons:** are these meant to be Lucide (this repo's convention)?
6. **Frame size** 422×672 isn't a device size. The build reproduces it for verification; the real app should be responsive.
7. **No interactions** are defined on this screen in Figma.

## Verification (2026-09-30)
- **Claims re-checked against the source** (`node verify/verify.mjs`, needs the Figma bridge): 62/62. Every colour mapping against the file's live variables, the `shadow/sm` claim against its effect styles, every font against Google Fonts, internal references, and the build's CSS values against the spec. A mutated spec (`#f7f6f3` claimed as `neutral/50`, the active-card shadow claimed as `shadow/md`) failed on exactly those 2 checks.
- **Consumed in Chromium** (browser MCP adapter): element geometry equals Figma's node boxes (both cards, the nav, and the Home indicator exact; buttons within 1px from text width). Pixel difference 1.27%, all of it text rasterisation (±1–2px per line; checked line by line).
