# Intent → Create — Measurement & Specification Report

Source of truth: the Figma frame **"Intent"** (node id `12008:3970`), read directly via the
Executor's `GET_DOCUMENT_STATE` command against the live Figma document — not estimated
from the exported screenshot. Every value below is either a literal Figma node property
(fill, stroke, corner radius, font, padding, auto-layout spacing) or a value derived by
simple arithmetic from those properties, with the arithmetic shown. Where a Figma property
maps directly to a CSS declaration, both are given so the mapping can be checked.

## 1. Frame / viewport

| Property | Value | Source |
|---|---|---|
| Frame size | 390 × 844 | `node.width` / `node.height` on `12008:3970` (standard iOS device frame) |
| Background fill | `#fcf9f2` | `node.fills[0].color` |
| Layout mode | `VERTICAL`, auto layout | `node.layoutMode` |
| Padding | top 55, right 20, bottom 42, left 20 | `node.paddingTop/Right/Bottom/Left` |
| Primary axis alignment | `SPACE_BETWEEN` | `node.primaryAxisAlignItems` — see §2 for how this was verified, not just copied |
| Sizing | `FIXED` × `FIXED` (390×844 exactly, not content-driven) | `primaryAxisSizingMode` / `counterAxisSizingMode` |

## 2. Top-level flow: `Top` / `Options` / `Footer` (space-between, verified by arithmetic)

Three in-flow children carry the `SPACE_BETWEEN` distribution; `StatusBar` and `HomeIndicator`
are excluded from it (see §3 — they're absolutely positioned overlays).

| Child | Height | y (measured) |
|---|---|---|
| `Top` | 260 (auto/HUG) | 55 |
| `Options` | 348 (auto/HUG) | 328.5 |
| `Footer` | 112 (auto/HUG) | 690 |

Verification that this is genuine `space-between` (not a hand-placed gap): content area height =
844 − 55 (top pad) − 42 (bottom pad) = **747**. Sum of the three children's heights = 260 + 348 +
112 = **720**. Remaining space = 747 − 720 = **27**, split into 2 equal gaps (between 3 items) =
**13.5 each**. Check: `Top` ends at 55+260=315; 315+13.5=328.5 = `Options`'s actual y ✓. `Options`
ends at 328.5+348=676.5; 676.5+13.5=690 = `Footer`'s actual y ✓. Both check out exactly, so the
screen is implemented with real `display:flex; flex-direction:column; justify-content:space-between`
on the 844px-tall container, not fixed pixel offsets — this reproduces the same behavior Figma
itself uses, not just the same numbers.

## 3. Status bar & home indicator (absolute overlays)

These two children have coordinates inconsistent with the flow above (`StatusBar` sits at y=0,
ignoring the 55px top padding; `HomeIndicator` sits at y=810, ignoring the 42px bottom padding) —
that's the signature of a Figma node with `layoutPositioning: ABSOLUTE`, floating independent of
the auto-layout flow. Implemented as `position: absolute` overlays on the `.screen` container.

**StatusBar** — 390×47, padding `8px 28px 0 32px` (`paddingTop/Right/Bottom/Left`), row layout,
`justify-content: space-between`, `align-items: center`.
- `Time` ("9:41"): Plus Jakarta Sans Medium 16px/20px, color `#002419`, x=32 (= left padding).
  y=17.5 is not a magic number — it falls out of `align-items:center` inside a 47px box with
  8px top padding: (47−8)/2 + 8 − 10(half line-height) = 17.5 exactly, confirmed by the math, so
  no manual y offset was needed in the CSS.
- `System` cluster (signal bars + battery): width 61, height 12, x=301 (390−28 right padding−61).
  4 bars + battery, **itemSpacing 6px** (verified: bar1 ends at x=3, bar2 starts at x=9 → gap 6;
  bar2 ends 12, bar3 starts 18 → gap 6; bar3 ends 21, bar4 starts 27 → gap 6; bar4 ends 30,
  battery starts 36 → gap 6 — consistent every time, so `gap: 6px` in a flex row, not 5 manual
  positions). Bars are bottom-aligned (`counterAxisAlignItems: MAX` → `align-items: flex-end`).
  - Bar 1: 3×5, radius 1 — Bar 2: 3×7, radius 1 — Bar 3: 3×9, radius 1 — Bar 4: 3×11, radius 1
  - Battery: 25×12, radius 3.5
  - All fill `#002419`.

**HomeIndicator** — 390×34, `justify-content:center`, `align-items:flex-end`, `padding-bottom:8px`.
  Pill: 134×5, radius 3, fill `#002419`. (x=128 exactly centers 134 in 390: (390−134)/2=128 ✓.)

## 4. `Top` section

`Top`: 350 wide (390−20−20 side padding), height 260 (auto), vertical flex, **gap: 24px**
(`itemSpacing`), no internal padding.

**Back button** (`.back-button`): 44×44, fill `#f6f3ec`, `border-radius: 9999px` (i.e. fully
round — Figma stores literal `9999` for "max radius", mapped straight to CSS `border-radius:
9999px`, which clamps the same way). Centered content (`align-items/justify-content: center`).
Icon: chevron-left, 20×20 box, stroke `#163a2d`, **stroke-width 1.667px** (Figma's exact
`strokeWeight`, not rounded to 2).

**Header** (`.header`): 350 wide, height 192 (auto), vertical flex, **gap: 12px**.
- `.step-label` ("STEP 2 OF 2"): Plus Jakarta Sans **SemiBold (600)**, 12px, line-height 16px,
  **letter-spacing 12%** → `0.12em` in CSS (Figma stores tracking as a percentage of the font's
  own size, which is exactly what CSS `em` units express — no unit conversion needed beyond
  `%→em`), `text-transform: uppercase` (Figma `textCase: UPPER`), color `#7c5716`.
- `.headline` ("What brings you here?"): **Newsreader** (serif — the only serif in the file;
  every other text node is Plus Jakarta Sans), Regular 400, `opsz` axis at 18 (Figma
  `variationSettings: {opsz:18, wght:400}` → CSS `font-variation-settings: 'opsz' 18`),
  **42px / 52px line-height**, letter-spacing **−1%** → `-0.01em`, color `#002419`, width 350
  (wraps to 2 lines — confirmed by node height 104 = 2 × 52px line-height).
- `.subtext`: Plus Jakarta Sans Regular 400, 16px/24px, color `#414844`, width 330 (narrower
  than the 350 column — wraps to 2 lines, height 48 = 2 × 24px confirms it).

## 5. `Options` section

350 wide, height 348 (auto = 4×78 + 3×12 gap = 312+36=348 ✓), vertical flex, **gap: 12px**.

### Option card (shared spec, both variants)

350×78, `border-radius: 16px`, horizontal flex, **gap: 16px**, **padding: 18px 20px**,
`align-items: center` (icon/text/radio vertically centered as a row).

| Variant | Fill | Border |
|---|---|---|
| `selected=true` (card 1 only) | `#fbebcf` | 1px solid `#eac488` |
| `selected=false` (cards 2–4) | `#ffffff` | 1px solid `#ebe8e1` |

Leading icon: 24×24, **stroke `#7c5716` in all four cards regardless of selection state** —
confirmed directly from the node data (every `LeadingIcon > Shape` reports the same stroke
color whether its card is selected or not; only the card background/border and the radio
change with selection, not the icon color). Stroke width 2px in every case.

Text block (`.option-text`): vertical flex, **gap: 2px**.
- `.option-title`: Plus Jakarta Sans **Medium (500)**, 16px/20px, color `#002419`.
- `.option-desc`: Plus Jakarta Sans Regular 400, 12px/18px, color `#59605b`.

Radio: 24×24, circular.
| State | Fill | Border | Content |
|---|---|---|---|
| checked (card 1) | `#ba8e48` | none | check icon, 14×14, stroke `#002419`, stroke-width 1.167 |
| unchecked (cards 2–4) | `#ffffff` | 1.5px solid `#eac488` | empty |

### Card content (verbatim from the design)

1. **My first 'Umrah** — *Guide me from the very start* — selected — icon: sparkles
2. **A quick refresher** — *I've been before* — icon: rotate-ccw
3. **Helping family** — *I want to teach someone* — icon: users
4. **Just learning** — *No trip booked yet* — icon: book-open

## 6. `Footer` section

350 wide, height 112 (auto = 56 + 8 gap + 48 = 112 ✓), vertical flex, **gap: 8px**,
`align-items: center` (centers the narrower ghost button).

**Primary button** (`.btn-primary`, "Continue"): 350×56 — **fixed width**, unlike the ghost
button below (`primaryAxisSizingMode: FIXED` vs `AUTO` — a real, deliberate difference in the
source file, not an oversight). Fill `#163a2d`, `border-radius: 9999px`, content
centered both axes, **gap: 8px** between label and icon. Label: Plus Jakarta Sans Medium
16px/20px, white. Icon: arrow-right, 20×20, stroke white, stroke-width 1.667.

**Ghost button** (`.btn-ghost`, "Skip for now"): height 48, **width auto** (135 in the source,
content-driven — reproduced as `width: auto` + horizontal padding rather than a hardcoded
135px, since that's what makes it behave correctly if the label ever changes), padding
`0 20px`, no fill/border, `border-radius: 9999px`. Label: same type spec as primary but color
`#163a2d` (dark green, not white — it's a low-emphasis action). Icon: arrow-right, 20×20,
stroke `#163a2d`.

## 7. Colors (design tokens)

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#fcf9f2` | screen background |
| `--ink` | `#002419` | headline, titles, status bar icons/text, check icon |
| `--ink-soft` | `#163a2d` | back-button icon, primary button fill, ghost button text/icon |
| `--text-muted` | `#414844` | subtext under headline |
| `--text-muted-2` | `#59605b` | option card descriptions |
| `--amber-dark` | `#7c5716` | "STEP 2 OF 2" label, all leading icons |
| `--amber-mid` | `#ba8e48` | checked radio fill |
| `--amber-line` | `#eac488` | selected card border, unchecked radio border |
| `--amber-bg` | `#fbebcf` | selected card fill |
| `--neutral-btn-bg` | `#f6f3ec` | back button fill |
| `--card-border` | `#ebe8e1` | unselected card border |

All values are exact — read from each node's `fills[0].color` / `strokes[0].color`
(0–1 float RGB converted to 0–255 and hex by the Executor's inspection command), not
sampled from a rendered image.

## 8. Shadows

**None found anywhere in this frame** — every node's `effects` array was empty (checked at
every level of the tree, not assumed). The flat look (cards distinguished only by fill +
1px border) is deliberate, not a missing shadow.

## 9. Typography summary

| Element | Family | Weight | Size | Line-height | Letter-spacing | Case |
|---|---|---|---|---|---|---|
| Step label | Plus Jakarta Sans | SemiBold (600) | 12px | 16px | +12% (0.12em) | UPPER |
| Headline | Newsreader (serif, opsz 18) | Regular (400) | 42px | 52px | −1% (−0.01em) | — |
| Subtext | Plus Jakarta Sans | Regular (400) | 16px | 24px | 0 | — |
| Option title | Plus Jakarta Sans | Medium (500) | 16px | 20px | 0 | — |
| Option description | Plus Jakarta Sans | Regular (400) | 12px | 18px | 0 | — |
| Button label | Plus Jakarta Sans | Medium (500) | 16px | 20px | 0 | — |
| Status bar time | Plus Jakarta Sans | Medium (500) | 16px | 20px | 0 | — |

## 10. Icons

All recreated as inline SVG (stroke-based, `currentColor`), not screenshots — matching how
the source file itself builds them (every icon in the Figma file is a stroke-only vector, no
fills). Names below match the Figma layer names exactly (`icon/sparkles`, `icon/rotate-ccw`,
etc.), which are standard Lucide icon names — strong evidence the source design uses the
Lucide icon set. The recreated icons are faithful redraws in the same style (not traced from
the original vector paths byte-for-byte), sized and colored to the measured spec:

| Icon | Box | Stroke width | Color | Used in |
|---|---|---|---|---|
| chevron-left | 20×20 | 1.667 | `#163a2d` | back button |
| sparkles | 24×24 | 2 | `#7c5716` | option 1 |
| rotate-ccw | 24×24 | 2 | `#7c5716` | option 2 |
| users | 24×24 | 2 | `#7c5716` | option 3 |
| book-open | 24×24 | 2 | `#7c5716` | option 4 |
| check | 14×14 | 1.167 | `#002419` | checked radio |
| arrow-right | 20×20 | 1.667 | white / `#163a2d` | primary / ghost button |

## 11. Verification method

The rendered HTML was screenshotted headlessly (Microsoft Edge, `--headless --screenshot`,
forced 1:1 device scale) and cropped to the exact 390×844 screen bounds (auto-detected by
scanning for the background color's bounding box, not assumed coordinates). Its color
transitions along a fixed vertical scan line (x=195, the horizontal center) were compared
against the same scan on a PNG exported directly from the Figma node
(`EXPORT_NODE`, scale 2, normalized back to 390-width coordinates). Card boundaries, button
top/bottom edges, and the home indicator all landed on **identical or ±2px** y-coordinates
between the two renders; the only larger deviations were a few px of noise through
text-heavy rows (headline, step label), consistent with normal cross-renderer font-hinting
differences rather than a structural or spacing error.
