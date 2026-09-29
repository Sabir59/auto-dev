# Design System Reference — extracted from File A ("Umrah & Hajj Guide")

Extracted via the Executor's `GET_DOCUMENT_STATE`/`SEARCH_NODES` while connected to
File A (fileKey `zT4549I0P5PWOsKgp99XJx`). Values are literal node properties, not
estimated. This is the reference I'll apply to File B without importing anything
from File A directly.

## Colors
| Token | Hex | Usage |
|---|---|---|
| bg | #fcf9f2 | screen background |
| ink | #002419 | headings, primary text, primary icon color |
| ink-soft | #163a2d | primary button fill, secondary icon/text accents |
| text-muted | #414844 | body/subtext |
| text-muted-2 | #59605b | secondary/description text (slightly lighter) |
| amber-dark | #7c5716 | eyebrow/overline labels, muted-context icons |
| amber-mid | #ba8e48 | selected/checked accents |
| amber-line | #eac488 | selected borders, unchecked control borders |
| amber-bg | #fbebcf | selected/highlighted surface |
| card-border | #ebe8e1 | default card/divider border |
| destructive | #c94039 | destructive action text (reset, clear, delete) |
| white | #ffffff | card/control surfaces |

## Typography
- Display/serif: **Newsreader**, `opsz` variable axis at 18. Used ONLY for headline-scale
  text (e.g. "What brings you here?" at 42/52, "Settings" title at 20/28 Medium).
- Everything else: **Plus Jakarta Sans** (Regular 400 / Medium 500 / SemiBold 600).
- Overline/eyebrow pattern: SemiBold 12px/16px, `letter-spacing: +12%`, uppercase, amber-dark.
- Body: Regular 16px/24px, text-muted.
- Row title: Medium 16px/20px, ink. Row description: Regular 12px/18px, text-muted-2/muted.

## Shape
- Cards: `border-radius: 24px`, 1px solid `card-border`, white fill.
- Pills/circular controls (buttons, avatar/icon buttons, switches, nav pill): `border-radius: 9999`.
- Card shadow (subtle, consistent everywhere a card appears):
  `drop-shadow(0 1px 2px rgba(0,36,25,0.06))` — i.e. color = ink at 6% opacity, y-offset 1, blur 2.

## Buttons (`Button` component set, variants by `variant=`/`size=`)
Confirmed variants in use: `default/lg`, `default/default`, `ghost/default`, `ghost/sm`,
`ghost/icon`, `secondary/icon`. Pattern: horizontal auto-layout, `border-radius:9999`,
`itemSpacing:8`, centered content, optional leading/trailing icon instance (icon visibility
is itself a component-level toggle, not always on by default — verify per-instance).
Primary (`default`) = ink-soft fill, white label. Ghost = transparent, ink-soft label.

## Cards
No single generic "Card" component — cards are auto-layout frames built to the shared
shape spec above (24px radius, border, shadow), each with its own internal content
(`SettingsRow` list, or free-form content). The pattern is the recipe, not one component.

## Navigation
- **StatusBar** (component): 390 wide, fixed 47 height, time + signal/battery cluster.
- **TopBar** (component set, `type=detail` variant confirmed): back button (circular,
  neutral-bg, `icon/chevron-left`) + overline/title text block, optional trailing action
  (hidden by default).
- **BottomNav** (component set): full-width dark... — actually in File A, `BottomNav` is a
  *light* surface with per-tab icon+label items and a pill/active-state indicator, plus a
  nested `HomeIndicator`. (Different from the dark-pill nav bar I invented ad hoc for
  "Home Screen" in File B — that was never derived from File A, it was pure invention.)
- **HomeIndicator** (component): thin centered pill, bottom-anchored.

## Icons
Stroke-based (no fills), Lucide-named (`icon/chevron-left`, `icon/chevron-right`,
`icon/check`, `icon/arrow-right`, `icon/sparkles`, `icon/rotate-ccw`, `icon/users`,
`icon/book-open`). Stroke width 1.667–2px depending on box size, `strokeCap/Join: round`.
Color is contextual (inherits the surrounding text/icon color token), not fixed per icon.

## List-row pattern (`SettingsRow` component set)
Three variants: `type=value` (label + current value + `icon/chevron-right`), `type=toggle`
(label + optional subtitle + `Switch` instance), `type=action` (label only, often
destructive-colored). Each row includes its own bottom divider (hidden on the last row in
a stack). This is the reusable "list of related settings/options" pattern — the same shape
used for cards containing multiple related controls.

## Auto Layout conventions
- Full-screen frames: `VERTICAL`, `primaryAxisAlignItems: SPACE_BETWEEN`, fixed size,
  padding roughly `{top:40-55, right:20, bottom:32-42, left:20}` — top/bottom content
  pinned, empty space absorbed in between (not a fixed gap).
- Chrome (StatusBar, HomeIndicator) is pulled out of that flow via
  `layoutPositioning: ABSOLUTE`, not treated as regular flow children.
- Cards/sections: `VERTICAL`, small `itemSpacing` (4–16), `counterAxisSizingMode: AUTO`
  (hug height), full-width via `layoutSizingHorizontal: FILL` on the child, not a
  hardcoded width.
