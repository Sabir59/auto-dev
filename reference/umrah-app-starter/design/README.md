# Design reference — Umrah & Hajj Guide

The Figma design, exported so the app can be built without opening Figma. **The light file is the source of truth.**

| Folder | What's inside | Use it for |
|---|---|---|
| `screens/light/` · `screens/dark/` | 28 screens + sheets per theme, numbered in app order | What "done" looks like. Compare every screen you build against both. |
| `spec/tokens.light.json` · `tokens.dark.json` | Every variable: palette, 28 Theme roles, spacing, radius, layout, fonts | Never hand-copy values — read them from here. |
| `spec/typography.json` (+ `.dark` for shadows) | 21 text styles, 3 shadows, the grid | Text style, shadow and grid definitions. |
| `spec/tokens.json` | Generated: light + dark value of all 28 roles | For tests (parity, contrast). |
| `spec/components.json` | All 36 components: every variant, prop, layout (direction, gap, padding), and the token behind each colour/radius/spacing | **The blueprint.** Build each component with the same name, variants and props. |
| `spec/screens-*.json` | Every screen as a tree: which components, with which props, and all real text | What each screen contains. Use the text exactly — it's been checked. |
| `spec/prototype.json` | Every tap: what it opens, closes, goes back to, or toggles | The navigation and interaction checklist. |
| `spec/icons.json` | 61 icons → their `lucide-react-native` component | Icon names. |
| `illustrations/` | 14 illustrations + the Emblem, as SVG | Wrap each as a react-native-svg component. |
| `icons/mosque.svg` | The one custom icon (Madinah tab) — same format as Lucide (24px, 2px stroke, `currentColor`) | Wrap it so it takes `size`/`color` props exactly like a Lucide icon. |

## Reading the spec
- `fill: "primary"` → the Theme role `primary` → class `bg-primary`. A hex value in the spec means the layer isn't tokenized; ask before hardcoding it.
- `layout: { dir, gap, pad: [top, right, bottom, left] }` → a flex container with `gap-*` and padding (use logical `ps-/pe-` for sides).
- `comp: "Button {variant=default, size=lg, disabled=false}"` + `props` → `<Button variant="default" size="lg">`.
- `bind` → which component property controls that layer's text or visibility.

## Notes
- **Illustrations:** the only colour that differs between light and dark is the background circle, `#F6F3EC` (light). In code, give that shape the `illustration-bg` token (light `#f6f3ec`, dark `#1d372f`); every other colour stays as drawn.
- **Dark spec:** the dark copy's component and screen JSONs are identical to the light ones apart from names, so only the light set is kept. Dark shadows are in `typography.dark.json`.
- **Icon `Mosque`** (Madinah tab) is not in Lucide — use `icons/mosque.svg`.
- **Contrast fix (approved):** light `brand-foreground` = green/950 and `ring` = gold/600. All 16 checked pairs pass in both themes.
