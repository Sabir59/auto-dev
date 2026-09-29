# MCP benchmarks

Real tasks run through the `figma_*` MCP tools only (no curl, no Scripter), against the live "Test Scripter" file. Each entry records what actually happened, including what went wrong.

## B1 — "Pack for Ihram" checklist screen (2026-09-29)

**Result:** page `Benchmark — MCP W3`, frame `Packing Checklist` (`12026:79`).

**Task:** build a new screen in the file's existing design system, reusing its real library components instead of drawing look-alikes: StatusBar, HomeIndicator, Back button (`Button {secondary, icon}`), five `OptionCard` checklist rows (packed = `selected=true`), a primary `Button {default, lg}` CTA, plus a new progress card. Every colour bound to a Theme variable; typography matched to the file's text styles (`overline`, `display/sm`, `body/lg`, `label/lg`, `label/md`).

**Inspection before acting:** file identity → pages → top-level nodes → variables (5 collections) → text/effect/grid styles → component trees → the existing `Intent` screen's tree and render as the style reference. The library components weren't on any page; their ids came from the `mainComponentId` of instances already used on `Intent`.

### To reproduce

Prerequisites: bridge running, plugin connected to "Test Scripter" (`RKIFhesaX0XrNL37ULYLcP`), then `figma_create_page` → `figma_switch_page` → build.

| What | Library component id | Instances in the result |
|---|---|---|
| StatusBar / HomeIndicator | `12008:3957` / `12008:3966` | `12026:90` / `12026:98` (both `layoutPositioning: ABSOLUTE`, y 0 / 810) |
| Back `Button {secondary, icon}` | `12008:3889` (+ `icon` → `icon/chevron-left` `12008:3772`) | `12026:82` |
| CTA `Button {default, lg}` | `12008:3807` | `12026:86` |
| `OptionCard {selected=true / false}` | `12008:3945` / `12008:3939` | `12026:111`, `:121`, `:130`, `:139`, `:147` |

Structure: `Packing Checklist` (VERTICAL, pad 55/20/42/20, SPACE_BETWEEN) → `Top` (gap 16: Back, `Header` [gap 12], `Progress Card` [pad 16/20, gap 12, radius 16], `Checklist` [gap 8]) + `Footer` (CTA, FILL). Theme variables bound: `background` `VariableID:10066:114`, `foreground` `:115`, `card` `:116`, `muted` `:124`, `muted-foreground` `:125`, `highlight` `:135`, `success` `:137`.

Integrity check afterwards: "Main" still has the same 12 top-level nodes (same ids, positions and sizes), and fresh PNG exports of `Intent` and `Confirmation` are byte-identical (SHA-256) to the ones taken before the run.

### Defects found by observing, and how each was fixed

| # | Observed | How it was detected | Fix | Verified by |
|---|---|---|---|---|
| 1 | Content ~97px taller than the space available; the CTA was pushed off-frame and clipped, the last card sat under the HomeIndicator | Predicted from the numbers before rendering; confirmed in the render, then measured exactly (`Top` 788px vs 691px available; Footer at y=843) | Two measured steps: tighter spacing (subtitle to 2 lines, gaps 24→16 and 12→8) → 724px; then card padding 20→16 and OptionCard vertical padding 18→14 → fits with a ~16px gap | Re-render + node heights |
| 2 | Back button showed → instead of ← | Render | Instance-swap property `icon` → `icon/chevron-left` (needed a new tool, see below) | Render; the properties now match the reference `Intent` Back button exactly |
| 3 | Leading icons hidden; once shown, all five were the same `book-open` icon | Render (and the shallow tree: LeadingIcon at 0,0 while Text started at x=21) | Only 7 icon components exist in the file and none fit packing items, so back to the design system default `showLeadingIcon=false`, set through the component property rather than a layer-visibility override | Direct read of the layer: `visible: false`; render |
| 4 | State change: "user packs sandals" must update four nodes consistently | — | Variant `selected=true` on Sandals + count text + percent text + bar width (248 = 80% of 310) | Screen tree: exactly 4 `selected=true` / 1 `false`; overridden text and padding survived the variant switch; render |

### Failure and recovery during the run

- **The plugin disconnected** between two turns (`pluginConnected: false`, bridge still up). Detected on the first call; only a human can re-run the plugin. Recovered after a manual re-run.
- **Lookups of existing nodes failed** with Figma's "Unable to establish connection to Figma after 10 seconds". Isolated step by step: `figma_ping` OK → plain ids OK → the parent instance read OK *and listed the failing id as its child* → every instance-sublayer id (`I…;…`) failing, including ones that had worked 10 minutes earlier, in instances not touched since. Internet reachable. **The condition cleared when the plugin reloaded** (triggered by editing `code.js`). A timed check (~130ms per call) showed the direct lookup succeeding, so the fallback added below **did not fire and is unproven**. Recovery lesson: editing `code.js` reloads the plugin and is a recovery action the AI can take itself.

### Executor changes made because of this run

- `plugin/code.js`: every lookup goes through `getNode()`. For an instance-sublayer id that throws, it resolves the outer instance and walks its subtree (unproven, see above). Any remaining failure now says it does **not** reliably mean "not found" and suggests checking via the parent.
- New capability `SET_INSTANCE_PROPERTIES` → tool `figma_set_instance_properties`: text, boolean, instance-swap and variant properties through `instance.setProperties()`. An unknown property name fails with the list of available ones (used deliberately once to discover them).

### Tool-interface findings (not yet fixed)

- `figma_set_auto_layout` defaults `layoutMode` to `VERTICAL`: a call meant to change only padding silently flips a horizontal layout. Here it was avoided by passing `HORIZONTAL` explicitly.
- There's no way to create a frame with *no* fill; the workaround is a fill with `a: 0`.
- The compact tree (`figma_get_screen_tree` / `figma_get_component_tree`) drops alpha: an `a: 0` fill reads back as `"fill": "#ffffff"`, which looks like a white background.
- There's no way to apply a text style (`textStyleId`); style values have to be copied by hand, so text isn't linked to the style.
- The `figma_modify_node` summary lists `fontSize, font` as applied on a `characters`-only edit. It's harmless (the render showed typography unchanged) but misleading.
