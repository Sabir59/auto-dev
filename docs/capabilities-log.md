# Executor capabilities log

Every time `plugin/code.js` gains a new command (or an existing one gains a new capability) to satisfy a starter-pipeline step, it's logged here: what it does, why it was needed, how it was verified against the live file. Entries are append-only, newest first.

Pre-existing commands (built during earlier POC phases, before this log existed) are documented in [how-to-drive.md](how-to-drive.md#command-reference-plugincodejs--handlers) instead of being back-filled here.

## GET_VARIABLES

**What:** Reads every local Variable collection (`figma.variables.getLocalVariableCollectionsAsync`), and for each variable resolves its value per mode, following `VARIABLE_ALIAS` chains across collections to a final literal (color → hex, float/string/boolean passthrough), while recording the immediate alias name and the variable's `codeSyntax`. General — works on any collection/variable/type, nothing Umrah-specific.

**Why:** `design/spec/tokens.*.json` in the reference pack is exactly this data (Figma Variables), previously produced by a human running a Scripter export script. This lets the Executor pull it directly, live.

**Verified against:** the real "Umrah & Hajj Guide" file (key `zT4549I0P5PWOsKgp99XJx`), cross-checked value-for-value against the reference's known-good `design/spec/tokens.light.json`:
- `Primitives` (mode `Default`, 62 vars) — `green/50..950` etc. hex values and `codeSyntax.WEB` match exactly (e.g. `green/50` → `#eefaf4`, `var(--color-green-50)`).
- `Theme` (mode `Light` only — the file has no Dark mode; dark values live in a separate Figma file, matching the reference's own "separate light/dark files" note) — alias resolution confirmed exactly: `background` → alias `neutral/50` → `#fcf9f2`; `foreground` → alias `green/950` → `#002419`; `card`/`popover` → alias `white` → `#ffffff`.
- `Spacing & Radius` (mode `Default`, 18 vars, type `float`) — `spacing/1`=4, `radius/sm`=4 … `radius/full`=9999, matching `generate-theme.mjs`'s expected keys.
- `Typography` (mode `Default`, 3 vars, type `string`) — `font/heading`="Newsreader", `font/body`="Plus Jakarta Sans", `font/arabic`="Amiri".
- `Layout` (mode `Default`, 14 vars) — present, not yet spot-checked value-by-value.

**Status:** PROVEN for color/float/string variables with cross-collection aliasing. Not yet tested: `BOOLEAN` type, a variable whose alias target itself has >1 mode (multi-hop mode-name mismatch).

## GET_STYLES

**What:** Reads local text styles, effect styles and grid styles (`figma.getLocalTextStylesAsync/EffectStylesAsync/GridStylesAsync`) — the other half of `design/spec/typography.json`. Text style `fontVariable` is resolved from `boundVariables.fontFamily` back to the bound Variable's name (ties into `GET_VARIABLES`'s `Typography` collection). Effect colors converted to hex via the same `variableColorHex` helper as tokens; grid colors left as raw `{r,g,b,a}` since Figma's own grid color isn't itself Variable-bindable the same way.

**Why:** the reference's `typography.json` (21 text styles, 3 shadows, 1 grid) is exactly this Figma Styles data.

**Verified against:** the live "Umrah & Hajj Guide" file, exact match against the reference's `design/spec/typography.json`:
- 21/21 text styles — spot-checked `overline`, `transliteration`, `quote`, `display/lg`: family/weight/size/lineHeight/letterSpacing/textCase/fontVariable/description all identical, including the `12%`/`0%`/`-1%` letter-spacing formatting and the "Code: ..." description strings (real designer-authored content, not generated).
- 3/3 effect styles — `shadow/sm` (single shadow), `shadow/md` and `shadow/lg` (two-layer composite shadows) — every x/y/blur/spread/hex value identical, including alpha-in-hex (`#0024190f`, `#00241912`).
- 1/1 grid style — `layout/mobile`, COLUMNS pattern, count/gutter/offset/color all identical.

**Status:** PROVEN.

## GET_ICON_COMPONENTS + `scripts/design-pack/extract-icons.mjs`

**What:** `GET_ICON_COMPONENTS` (plugin) finds every `COMPONENT` whose name starts with a prefix (default `icon/`) on a given page, and derives the PascalCase name via a pure kebab→Pascal transform (no lookup table, so it's not tied to Lucide or any one icon set). `extract-icons.mjs` (script, has network — the plugin sandbox doesn't) then checks each one **live** against `raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg` to decide `custom` honestly, instead of trusting a remembered/static Lucide list.

**Why:** `design/spec/icons.json` needs `{figma, component, custom}` per icon; "custom" is only meaningful if checked against Lucide's *current* set.

**Verified against:** the live file's `GuideLines` page (found the 61 icon master components — matches the reference's own `design/README.md` count):
- All 61 `figma`/`component` names match the reference's `icons.json` exactly.
- Live check surfaced a real, useful finding the reference itself gets wrong: reference's `icons.json` lists `mosque` as `custom: false`, but its own `design/README.md` and `design/icons/mosque.svg` say the opposite (not in Lucide). Direct fetch shows **Lucide has since added a native `mosque` icon** (valid SVG returned; a made-up icon name correctly 404s for contrast) — so today, `custom: false` for mosque is correct and the reference's older doc/custom-SVG are the stale part.
- The live check also flagged `circle-help` and `trash-2` as `custom: true` (404 under those exact names) — but this isn't hand-drawn-art custom. Direct probing found Lucide has **renamed** them: `circle-help` → `circle-question-mark`, `trash-2` → `trash` (both return 200). The script reports these honestly as "not found under this name" rather than guessing a rename mapping; a human/downstream step decides whether to re-map or keep custom art.

**Status:** PROVEN, with a real caveat: "custom" from a live name check means "not found under this exact name today," which can mean genuinely custom OR a Lucide rename — the script doesn't (and shouldn't, without more evidence) auto-resolve renames.

## GET_COMPONENT_TREE

**What:** Reads a `COMPONENT` or `COMPONENT_SET` into `design/spec/components.json`'s compact tree shape (`design/README.md`'s "blueprint"): top-level `props` (from `componentPropertyDefinitions` — TEXT/BOOLEAN/INSTANCE_SWAP/VARIANT, with INSTANCE_SWAP defaults resolved id→name and VARIANT keeping its `options` list), then one `{variant, tree}` per variant (or a single `"default"` for a standalone COMPONENT). Each tree node recursively carries `layout` (dir/gap/pad/main/cross, with gap/padding resolved to their bound Variable name via `boundVariables.itemSpacing`/`paddingTop` etc. when tokenized), `size` (`layoutSizingHorizontal/Vertical`, Figma's own FIXED/HUG/FILL enum verbatim), `radius`/`fill`/`stroke` (resolved to the bound Variable's name — corner radius bindings live under the per-corner key `topLeftRadius` even when uniform), `effect` (via `effectStyleId` → style name), TEXT `style`/`color`/`align`/`value` (style via `textStyleId`), and `bind` (`componentPropertyReferences`, stripped of Figma's internal `#nodeId` suffix). Instances are treated as leaves (`comp` + always-present `props`, no recursion into their internal structure — matches the reference's own convention of not repeating a component's definition at every use site), and children that are hidden by a property's default (`visible: false`) are left out of the default tree, same as the reference does.

**Why:** this is the reference's hardest/richest file — the actual blueprint a build has to match variant-for-variant, prop-for-prop, token-for-token.

**Verified against:** the live file, exact `assert.deepStrictEqual` match (not eyeballed) against two real reference entries:
- `ArticleCard` (standalone COMPONENT, 3 nesting levels, mixed frame/text/instance children, an INSTANCE_SWAP prop resolved through a Button instance) — exact match after fixing 5 real gaps found by diffing: the `topLeftRadius` bound-variable key (not `cornerRadius`), stripping the `#id` suffix from `bind` values, excluding the hidden-by-default `Image` child, treating instances as leaves, and always emitting `props: {}` on instances even when empty.
- `Badge` (COMPONENT_SET, 5 variants) — exact match after one more fix: top-level `props` must still include `VARIANT`-type properties (with their `options` list) and resolve `INSTANCE_SWAP` *defaults* id→name too, not just per-instance overrides.

**Status:** PROVEN for both COMPONENT and COMPONENT_SET, cross-checked byte-for-byte against known-good reference data — not just internally consistent.

## SWITCH_PAGE

**What:** `figma.setCurrentPageAsync(page)` — the same operation Figma's own UI performs when a human clicks a page tab.

**Why:** under `dynamic-page` access, only the current page's nodes are eagerly available; anything else needs loading first. `page.loadAsync()` (used by `SEARCH_NODES`/`GET_DOCUMENT_STATE` when given a `pageId`) repeatedly failed with Figma's own "Unable to establish connection to Figma" error the first time a page was touched after this plugin's sandbox reloaded (which happens automatically every time `code.js` is edited) — and only a real human click on that page tab reliably cleared it, which got disruptive during heavy iteration. `SWITCH_PAGE` gives the Executor the same page-warming action a human click does, so it can drive multi-page work itself instead of asking a human to click through it.

**Verified against:** the live file — switched to the never-before-touched "Proposal" page immediately after a fresh plugin reload (no human click), confirmed via `GET_FILE_INFO` that `currentPage` updated, then switched back to "Components".

**Status:** PROVEN as a real fix for the page-load flakiness. Not fully explained: why `loadAsync()` alone is unreliable right after a reload while `setCurrentPageAsync` isn't — treated as an empirically-found workaround, not a root-cause fix inside Figma itself.

## GET_SCREEN_TREE

**What:** Reads a screen `FRAME` into `design/spec/screens-*.json`'s shape: `{name, originalName, tree}`, where `tree` is the exact same compact node tree `GET_COMPONENT_TREE` produces (the two now share one `describeNode` implementation instead of duplicating ~150 lines — refactored out to module scope).

**Why:** screens are just deeper/wider instances of the same tree shape components use — no new serialization logic needed, only a different top-level wrapper.

**Verified against:** the live file, exact `assert.deepStrictEqual` match against two real reference screens:
- `01 Welcome` (simple, 3 levels deep) — exact match except `originalName`: reference says `"Screens / Welcome"`, live file says `"01 Welcome"` — the frame has genuinely been renamed since the reference was exported (another real content-drift case, like the Lucide renames). Not an extraction bug.
- `15 Saved` (deeper, real component instances incl. `SavedItemCard`) — exact match after fixing a second real bug this surfaced: `node.strokeWeight` is `figma.mixed` (a Symbol) when a node has independently-set per-side stroke weights, which crashed a template-literal interpolation (`"cannot convert symbol to string"`). Fixed to render as `""` — matching the reference's own output for the same node (`"stroke": "border "`, trailing space, empty weight) rather than inventing a `"MIXED"` label.

**Status:** PROVEN on the 2 screens spot-checked at build time — since extended to all 28, see below.

## GET_PROTOTYPE

**What:** Walks every top-level screen `FRAME` on a page, collecting every node's `.reactions` into `design/spec/prototype.json`'s shape: `{flows, screens}`. `flows` is the page's real `flowStartingPoints` (Figma's own prototype-entry markers). Each reaction becomes `{on, trigger, action, to, transition}`: `on` is a `" › "`-joined breadcrumb from the screen root down to the reacting layer; for a `NODE` action, `action` is `navigate`/`change_to`/`overlay`/`scroll_to` (mapped from Figma's `navigation` enum: NAVIGATE/SWAP/OVERLAY/SCROLL_TO) and `to` is the destination's name (a plain screen name for NAVIGATE, or `SetName {variant=value}` for a SWAP, since the destination is a bare variant, not an instance); `BACK`/`CLOSE` actions map to `back`/`close overlay`; `transition` is `"instant"` when absent, else `"type duration s"`.

**Why:** this is the tap-by-tap navigation/interaction checklist — the last of the six `design/spec/` files.

**Verified against:** the live file — `flows` matches exactly (one entry, the Welcome screen), and after one fix (below), **all 28 screens' reaction arrays match the reference exactly** (`assert.deepStrictEqual`, every screen, not a subset) — covering every action/trigger/transition value the reference actually uses (`navigate`, `change_to`, `back`, `overlay`, `close overlay`; `push`/`smart_animate`/`move_in`/`instant` transitions).

**Fix found:** Figma stores transition `duration` as a 32-bit float internally, so reading it back as a JS double surfaces artifacts like `0.30000001192092896` for what was entered as `0.3` — rounded to 3dp to undo that (same underlying lesson as the `strokeWeight` mixed-value issue above: reading raw Figma numeric properties needs care about their storage precision/type, not just their conceptual meaning).

**Status:** PROVEN, full-file scale, not a spot check.

## Full-scale screen verification (all 28, not just 2) — 4 more real fixes

Once `GET_PROTOTYPE` made it cheap to fetch every screen anyway, re-ran `GET_SCREEN_TREE` against **all 28** live screens (not just the 2 spot-checked above) and diffed each against its reference entry. Surfaced 4 real gaps the 2-screen sample had no way to hit:

- **`abs` was missing entirely.** A child pulled out of auto-layout flow (`layoutPositioning: "ABSOLUTE"` — e.g. a status bar pinned to the screen top, a home indicator pinned to the bottom) needs its own `[x, y]` offset recorded, since flow-relative comparison to siblings is meaningless for it. Added `abs: [round(x), round(y)]` whenever `layoutPositioning === "ABSOLUTE"`.
- **Dashed strokes lost the `dashed` suffix.** A stroke with a non-empty `dashPattern` needs `" dashed"` appended (used for dashed connector lines between stage nodes on the learning-path screens).
- **Radius token resolution order was backwards for a real, meaningful case.** A bottom sheet has only its top two corners rounded (bottom corners literal `0`) — Figma reports `cornerRadius === figma.mixed` for that, and the old code jumped straight to a bare `"MIXED"` string without even trying to resolve a token. Fixed to always attempt `topLeftRadius`'s bound-variable name *first*; only fall back to `"MIXED"`/a raw number when no corner is actually tokenized. (`ArticleCard`/`Badge` happened not to have any mixed-but-still-tokenized radius case, so this didn't surface until testing at full screen scale.)
- **`opacity` wasn't read at all.** A semi-transparent scrim behind a bottom sheet needs it. Added (only when ≠ 1, matching the "omit the default" convention already used elsewhere).

All 4 fixes are in the shared `describeVisuals`/`describeLayout` used by both `GET_COMPONENT_TREE` and `GET_SCREEN_TREE` — re-verified `ArticleCard` and `Badge` still match exactly afterward (no regression).

**Status:** PROVEN, 28/28 screens, exact `assert.deepStrictEqual` match, zero diffs remaining.

## EXPORT_NODE format param (screenshots + illustrations)

**What:** `EXPORT_NODE` already existed (PNG-only, proven earlier this session) — added a `params.format` (default `"PNG"`), passed through to `node.exportAsync`. Raster formats (PNG/JPG) keep the scale constraint; vector formats (SVG/PDF) omit it, since Figma rejects a constraint object for those. `format` is threaded through `ui.html`'s binary-to-base64 conversion and the bridge's file-write step, which now picks the written file's extension from it instead of hardcoding `.png`.

**Why:** `design/screens/{light,dark}/*.png` (screenshots) and `design/illustrations/*.svg` + `design/icons/*.svg` are both just `EXPORT_NODE` at a different format — no new Figma capability needed, just a param that was hardcoded.

**Verified against:** the live file:
- Screenshot: exported "01 Welcome" at `scale: 1` → exactly 390×844 (matching the reference screenshots' actual pixel size — confirmed by reading the reference PNG's own IHDR chunk, not assumed) → visually identical to `design/screens/light/01 Welcome.png`.
- Illustrations: found all 14 `illustration/*` components + the separate `Emblem` component on the `Assets` page (matches the reference's 14 + Emblem count exactly). Exported `Emblem` (176×176) and `illustration/ihram-men` (280×320, a more complex multi-part illustration) as SVG — both **byte-for-byte identical** (`diff`, not eyeballed) to the reference's `design/illustrations/emblem.svg` and `ihram-men.svg`.

**Operational bugs found while wiring this up (not Figma API bugs — this repo's own bridge/reload process):**
- The bridge (`bridge/server.js`) is a separate long-running Node process — editing it does **not** hot-reload like `code.js` does. `pkill -f "node server.js"` silently failed to match the real Windows process (started earlier via `nohup … &`), so the OLD bridge code kept running underneath a seemingly-successful "restart." Caught by checking `netstat`'s actual listening PID and `taskkill //PID //F`-ing that specific PID, not by trusting the kill command's exit status.
- `ui.html` (the plugin's iframe) does **not** hot-reload when `code.js` changes — only a full plugin relaunch (Plugins → Development → re-run) picks up a `ui.html` edit. `code.js`-only edits (all the capabilities above) took effect automatically; this one needed the human to explicitly re-run the plugin, not just click a page tab.

**Status:** PROVEN. `design/` is now fully covered: tokens, typography, icons, components, screens, prototype, screenshots, illustrations.
