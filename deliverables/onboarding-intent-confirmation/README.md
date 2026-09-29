# Implementation package — Onboarding: Intent → Confirmation

Everything needed to build these two screens without opening Figma. Source: Figma file **Test Scripter** (`RKIFhesaX0XrNL37ULYLcP`), page **Main**, frames `Intent` (`12008:3970`) and `Confirmation` (`12015:4053`), read on 2026-09-30.

| File | What's inside |
|---|---|
| `tokens.json` | The colours, spacing, radii, fonts and text styles these screens use, with values. Never hand-copy values; read them from here. |
| `components.json` | The 5 components used (Button, OptionCard, RadioIndicator, StatusBar, HomeIndicator): props, the variants used, layout, and the token behind each value. |
| `screens.json` | Each screen as a tree: which components, with which props, and all the real text. |
| `prototype.json` | Every tap interaction Figma defines on these screens. |
| `icons/*.svg` | The 7 icons (Lucide shapes, 24px viewBox, `stroke="currentColor"`). Set the colour with CSS `color`. |
| `reference/*.png` | Figma's own render of each screen at 1× (390×844). This is what "done" looks like. |
| `build/` | A reference HTML/CSS implementation built **only** from the files above (`node build/build.mjs` regenerates `tokens.css` and the `.html` files). |
| `verify/` | That implementation's browser screenshots, pixel diffs against `reference/`, and results. |

## Reading the spec
- A string such as `"fill": "primary"` is a token from `tokens.json`. A number is a px value.
- `pad` is `[top, right, bottom, left]`. `layout.dir` `row`/`col` is flex direction. `main`/`cross` are `justify-content`/`align-items` (`MIN` = start, `MAX` = end).
- `size: "FILL/HUG"` = width fills the parent, height fits the content.
- Figma draws these strokes **inside** the box, so use CSS `border` with `box-sizing: border-box`.
- `StatusBar` and `HomeIndicator` are device placeholders (safe-area insets in a real app), positioned absolutely.

## Things a developer would otherwise get wrong
- **Icon sizes and colours vary per use** (from the Figma instances): leading icons 24px `highlight`; Back chevron 20px `secondary-foreground`; radio check 14px `foreground`; button arrow 20px `primary-foreground`. The stroke scales with the icon, **except** the 40px Confirmation check, which keeps a 2px stroke (use `stroke-width: 1.2` in the 24px viewBox).
- **Newsreader optical size:** leave optical sizing automatic. Figma *reports* `opsz 18` on these text nodes, but its render matches opsz = font size (measured; see `tokens.json › font/heading`).
- **Transparent groups:** `Content` and `Footer` on Confirmation have no background, even though Figma's compact tree shows `#ffffff`; the fill is at alpha 0.

## Open questions for the designer
1. **Confirmation isn't tokenized.** Its background, badge, headline and subtext use raw values and no text style. Each raw value equals a token exactly, so the package uses those tokens (marked `"inferred": true` in `screens.json`), but they should be bound in Figma.
2. **Navigation isn't wired.** `Continue` and `Skip for now` on Intent have a navigate action with **no destination** in Figma. The package assumes Continue → Confirmation (the stated goal); Skip's destination is unknown.
3. **Selection behaviour.** Figma only models each OptionCard toggling itself. OptionCard's description says it's a RadioGroup item (single-select), which implies selecting one deselects the others. Please confirm.

## Verification (2026-09-30)
- `node worker/check-package.mjs <this folder>`: **ok**. 62 token references, 13 component references, 8 icon references, all resolved. A mutated copy (a broken token, a missing icon, a wrong variant, a missing render) failed with all 4 problems reported.
- `build/` rendered in Chromium (via the browser MCP adapter) vs `reference/` (`worker/pixeldiff.mjs`, pixelmatch threshold 0.1):

  | Screen | Differing pixels | What remains |
  |---|---|---|
  | Intent | 1.22% | Every box (cards, radios, buttons, badge) at the same position and size; text lines ±1px horizontally; `body/lg` lines 1px higher; anti-aliasing |
  | Confirmation | 0.60% | Same: all element extents identical; `body/lg` 1px higher |

  The residual is renderer rounding (Figma vs Chromium), not a spec error. Chasing it with 1px nudges would overfit one browser.
