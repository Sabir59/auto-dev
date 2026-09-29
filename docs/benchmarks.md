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

## B2 — Failure and recovery while building "Packing Checklist — Sections" (2026-09-29)

**Question:** can the AI recover from a real failure *while completing a meaningful task*, without restarting blindly?

**Result:** frame `Packing Checklist — Sections` (`12029:163`), next to B1 on page `Benchmark — MCP W3`. The checklist is regrouped into "To pack · 1" (Waist pouch, `selected=false`) and "Packed · 4" (4 × `selected=true`), with the same Back/CTA/StatusBar/HomeIndicator library components, every colour on a Theme variable, and text/icon changes made through `figma_set_instance_properties` rather than layer overrides.

### Baseline probe, before any failure (healthy environment)

| Lookup | Result |
|---|---|
| `figma_ping` | `pong` |
| Plain id that doesn't exist (`12026:99999`) | `Node not found` (clean, immediate) |
| Instance-sublayer id that doesn't exist (`I12026:111;99999:1`) | `Node not found` (clean, immediate) |
| Instance-sublayer id that exists (`I12026:111;10070:7026`) | Resolves |

This **contradicts the Phase 3 note** that a nonexistent id produces the "Unable to establish connection" error. In a healthy plugin, missing really does mean missing. Together with B1 (where *every* nested lookup failed, including ids known to exist), the ambiguous error looks like **a mode the plugin sandbox gets into, not a property of the requested node**.

### F1 — Bridge process killed mid-task (environment failure, introduced deliberately)

The bridge process was killed (`Stop-Process -Force`) in the same moment as a `figma_create_instance` for the first "Packed" card, so it was unknown whether the write would land.

1. **Honest note on the race:** the create won. It returned `12029:199` before the kill landed, so this run did *not* produce an uncertain in-flight write. (PowerShell's startup time, hundreds of ms, loses to a ~100ms create; a reliable in-flight kill needs a slower write or a faster killer.)
2. **Observe:** the *next* task step (`set_instance_properties` on that card) failed: `Could not reach the Figma bridge … fetch failed`.
3. **Diagnose:** the error came from the MCP layer (it never reached Figma), which points at the environment rather than the task. That was confirmed rather than assumed: `netstat` showed nothing listening on 8787, and no `server.js` node process existed. So the bridge was dead, and the Figma document itself was unaffected.
4. **Recover (autonomous):** restarted `node bridge/server.js` in the background. `ui.html`'s reconnect backoff re-attached the plugin **1.5s** after the bridge came up. No human action.
5. **Re-establish identity before continuing:** `figma_ping` OK, and `figma_get_file_info` showed the same file key (`RKIFhesaX0XrNL37ULYLcP`) and the same page. A reconnected plugin isn't necessarily the same file.
6. **Reconcile state instead of replaying:** read `Section — Packed`. It had exactly **one** card (so re-issuing the create would have made a duplicate), with default text "Option"/"Description" (so the failed write had *not* applied, which matches the `fetch failed` reasoning, now confirmed by data).
7. **Resume at exactly the failed step**, then finished the remaining three cards.

### A task/state failure, handled separately

The render showed section headings sitting 16px under the subtitle, the same as the gap between sections, so they didn't read as section breaks. That's a design defect, not an environment one. Fix: `Top` spacing 16→24 (the file's `page/padding-top` value; B1 needed 16 only because it was out of room). The first re-export was issued *in parallel* with the change, so it might have shown the pre-change state. It was discarded and re-exported after the write returned, rather than trusting a possibly stale render.

### F2 — The ambiguous lookup failure: what can and can't be done autonomously

- **Is the connection itself healthy?** Yes, this can be checked: `figma_ping` touches no document state, so it separates "plugin not reachable" from "lookup failing".
- **Genuinely missing vs. temporarily unavailable?** Yes, by checking against a known-good node. Look up a nested id known to exist. If that fails too, the plugin is in the failure mode (environment problem, retry after recovery). If it resolves and the target returns `Node not found`, the target really is missing. Reading the target's parent and checking whether it lists the id gives the same answer (used in B1).
- **Recovery without a manual reload?** The action is available. A content-free `touch plugin/code.js` made Figma reload the plugin **1.6s** later, and it reconnected **0.36s** after that, healthy (same file, the known-good lookup resolved). **Not proven end-to-end:** the failure mode didn't occur during B2 and can't be triggered on demand (its cause is inside Figma and still unknown), so "reload clears the failure mode" rests on the single B1 observation. It only works for a *development* plugin with Figma watching `code.js`, not a published one.
- **Still needs a human:** if the plugin window is *closed* (B1's disconnect), there's nothing to hot-reload. Figma has no API to launch a plugin, so re-running it by hand is still required. That's a current limitation, not autonomous recovery.

### Recovery procedure established by B1 + B2

1. A tool call fails → classify it by where the error came from: the MCP layer ("could not reach the bridge") vs. the plugin (Figma error text) vs. the task (a clear validation error such as an unknown property name).
2. Environment checks: bridge listening (`netstat`) → `/status` `pluginConnected` → `figma_ping` → `figma_get_file_info` (same file key?).
3. Bridge dead → restart it; the plugin reconnects on its own. Plugin disconnected and not reconnecting → a human has to re-run the plugin.
4. Lookup failing while ping is OK → check a known-good nested id. If it also fails → `touch plugin/code.js`, wait for the reconnect, check the known-good id again.
5. **Before retrying any write, read the affected state** and resume from what actually exists. Never replay steps from memory.
6. Verify the final result both ways: the structural tree (counts, variants, tokens) and a render exported *after* the last write returned.

### Honest gaps in this benchmark

- The in-flight uncertain-write case (F1 step 1) wasn't produced; the reconciliation step was exercised, but against a write that had clearly completed.
- The ambiguous-lookup recovery is supported in pieces (known-good check proven, reload proven, "reload clears the mode" observed once), not end-to-end.
- The restarted bridge runs as a background process of this Claude Code session, not the original terminal.

## B3 — First worker loop: goal → implementation package (2026-09-30)

**Goal given:** "Produce an implementation package for the onboarding step Intent → Confirmation in Test Scripter, so a developer can build it without opening Figma. Prove it's usable."

**Deliverable:** `deliverables/onboarding-intent-confirmation/` (see its README): tokens, components, screens, prototype, 7 icons, 2 reference renders, a reference HTML build made only from the package, and the verification artefacts.

**Worker implementation:** none beyond this Claude Code session using the existing Figma and browser MCP tools, files and shell. Two small checks that aren't specific to any environment were added in `worker/`: `check-package.mjs` (every reference inside the package resolves) and `pixeldiff.mjs` (pixelmatch plus a per-band breakdown to locate differences). No orchestrator, no plan file, no second agent.

### What the worker decided, and what drove each decision

| Observation | Decision |
|---|---|
| The repo already has a known-good design package (`reference/umrah-app-starter/design/`) | Model the deliverable on that format instead of inventing one |
| `intent-create-html/` already hand-converted Intent to HTML | Don't read or reuse it (that would copy an answer, not test the loop) |
| Confirmation uses raw hex values and no text styles; each equals a token exactly | Map them to tokens, but mark them `inferred` and raise it as an open question instead of silently cleaning it up |
| The compact tree says `Content`/`Footer` fill `#ffffff`; the render shows none | Check exact state: alpha 0, so record them as transparent |
| Prototype: both Intent footer buttons navigate to `null` | Read `code.js` to learn what `null` means (no destination, not a failed lookup, since a failed lookup throws) → report "unwired" rather than invent the link |
| The component trees omit hidden-by-default layers (LeadingIcon, button Icon) | Take their size and colour from the actual instances and record the source node ids |
| Icon instances differ in size, colour and stroke scaling (the 40px check keeps a 2px stroke) | Record each use; normalise the SVGs to `currentColor` |
| First pixel diff 1.97%, located by band; the render showed no radios | Implementation bug (a `.title` class collision), not a package bug → fixed the build |
| The headline band was still the largest; crop comparison showed a narrower, lighter headline | Measured instead of guessing: Figma ink 286px; Chromium at opsz 18 gives 274px, at auto ~287px → **the package's own "opsz 18" instruction was wrong** (Figma reports opsz 18 but renders at auto) → fixed the package |
| Remaining 1.22% / 0.60%: all element boxes identical; body text ±1px | Accept as renderer rounding and document it; don't overfit with 1px nudges |
| Build and page load had been issued in parallel | Re-navigated before screenshotting, so a stale render couldn't be verified |

### Failures during the run

1. **Figma lookup failure mode (natural, at the very first calls).** `GET_PROTOTYPE`/`GET_SCREEN_TREE` failed. Diagnosis: `figma_ping` OK; a nested text node resolved; instances and anything on another page failed. Main page `12002:3691` failed a direct lookup although `figma_list_pages` had just listed it → **it exists; the lookup is temporarily unavailable**. The common factor was resolving remote-library components or unloaded pages. Recovery attempts: a plugin reload via `touch plugin/code.js` (reloaded in ~2s, **didn't clear it**, which disproves the single B1 observation); a page switch through the API (failed). Checking Figma's own network connections from the OS was inconclusive. While blocked, the worker built `pixeldiff.mjs` (it doesn't depend on Figma) and then asked the human to look at the Figma window. **After a human action in the Figma UI, everything resolved.** Autonomous: detection, diagnosis, the missing-vs-unavailable call, and the attempted recoveries. Human: the actual fix.
2. **A real capability gap (`GET_COMPONENT_TREE` on a variant).** Every instance's `mainComponentId` is a variant, and the tool crashed on variants (Figma forbids `componentPropertyDefinitions` on them). No other tool exposed the parent set, and the only fallback (`get_document_state`) gives raw hex and remote variable ids, which forces ambiguous guessing of tokens from colours. The fix is 1 line in `plugin/code.js` (a variant resolves to its parent set). Released as `figma-adapter-v0.2.1`.
3. **Error-text bug:** `getNode`'s message printed `(undefined)` because Figma's thrown value had no `.message`. Fixed.

### What this proves
- From a goal stated in outcome terms, the worker chose the environments (Figma for the source, files for the package, the browser for proof), the order, and the intermediate checks; it wasn't following a supplied call sequence.
- It made several decisions based on observed state that changed the deliverable, and it caught and fixed **its own** wrong conclusion (opsz) by measuring the rendered output.
- "Done" was decided by checks, not by assertion: the consistency check passed (and was shown to fail on a broken copy); the from-package build matched Figma with identical element geometry and 1.22% / 0.60% renderer-level pixel difference.
- The worker kept implementation bugs separate from package bugs, and environment failures from task failures.

### What it does not prove
- **Generality:** one flow, two simple screens, in a design system already seen in B1/B2.
- **That a real developer would find it usable:** the "developer" was the same session that wrote the package. The build *was* restricted to package values (no colour literals outside the generated `tokens.css`, checked by grep), but an independent consumer is the real test.
- **Goal decomposition from nothing:** the goal and the idea of verifying through a build came from the brief.
- **Autonomous recovery from the Figma lookup mode:** a human was still needed; the reload remedy has now failed once and worked once.
- Anything about React Native, dark mode, or production code.

## B4 — Generalisation: a goal-driven order in a live web app (2026-09-30)

**Goal (fixed before the site was inspected):** "Using the demo store at saucedemo.com, place the cheapest order that equips a new team member with three things: something to carry their gear, a light, and a top they can wear. Keep it under $60 before tax. Deliver a report of what was ordered and why, and prove the amount charged is correct."

**Deliverable:** `deliverables/b4-saucedemo-order/`: `report.md`, the captured `products.json` (full catalogue plus the worker's classification) and `checkout-summary.json` (captured before Finish), `verify.mjs`, and `order-complete.png`.

**Result:** order confirmed by the site ("Thank you for your order!", cart back to empty). Backpack + Bike Light + Bolt T-Shirt: $55.97 before tax, $4.48 tax, $60.45 charged. `verify.mjs` passed all 9 checks and was shown to fail on a mutated summary (the Onesie ordered instead). About 30 browser tool calls; no Figma.

### How the worker ran it (the sequence was not supplied)
Inspected the login page → found the accepted accounts and password on the page and **chose `standard_user`** (the other five are named as faulty) → looked up the real input selectors rather than guessing them (the site uses `data-test`) → logged in with dependent steps in sequence → captured the whole catalogue to a file → **classified the products and excluded the Onesie** (the cheapest "top", but an infant garment) → **found and reported the $15.99 tie** → added 3 items → **checked the cart page itself**, not just the badge count → filled checkout with **placeholder data, not a real person's** → captured the summary → **ran an independent verifier and mutation-tested it before pressing Finish** (the step that's irreversible in a real shop) → finished → checked the completion state.

### Answers to the B4 questions
- **What transferred from B1–B3:**
  - Inspect before acting, and look up selectors or ids rather than guess them.
  - Run dependent steps in order, never in parallel (learned the hard way in B2/B3).
  - Check the authoritative state after acting (the cart page, as with B2's "read before retry").
  - Save observations to files and verify from them with a separate deterministic script, then prove that script can fail (B3's mutation test).
  - Keep judgements visible (ties, exclusions and assumptions reported, as with B3's open questions).
- **What did not transfer, or wasn't needed:**
  - All the visual-verification machinery (pixel diff, renderer rounding, reading renders). This environment exposes exact text state, so the screenshot is only evidence. That's the "prefer exact state" rule working as intended, not a gap.
  - The Figma failure knowledge (lookup mode, remote libraries) has no counterpart here.
  - **Recovery wasn't exercised at all:** no failure occurred, and none was faked.
- **New behaviour this environment required:**
  - Verify *before* the irreversible step, not just after. Figma edits were cheap to redo; checkout isn't.
  - Judgement about what data to enter into a third-party system.
  - Reading a constraint precisely: the charged $60.45 is over $60, but the goal limited the pre-tax amount.
- **Did the worker choose environments rather than being told?** Weakly tested. The store is only reachable through the browser. The real choices were to verify with Node against captured files rather than trust the site's arithmetic or re-read the page, and to not use Figma at all.
- **State across operations:** yes. The intended cart was carried from the decision through the inventory, cart and summary pages, and checked against the site's actual state at two points (the cart page and the summary).
- **Independent verification:** yes. `verify.mjs` uses no browser, only captured data. It re-derives the optimum by brute force and re-derives the totals and the tax rate, and it rejects a plausible wrong order.
- **Did reasoning change the result?** Yes. A price-only "cheapest top" would have ordered the infant Onesie ($47.97, a wrong order). The tie was reported instead of hidden.
- **Is the tool interface enough for another environment?** For this task, yes: 5 generic browser tools, **no new capability needed**. Friction observed, not blocking:
  - `browser_get_dom_state` with a selector returns details only for the *first* match (`matches: 4`), so each field had to be queried separately.
  - There's no download capture, so the site's "Generate PDF order" receipt couldn't be collected. The proof didn't need it.
  - There are no keyboard or `<select>` tools; this task didn't need them.
- **New capability required:** none. Nothing was added to any adapter.

### What B4 does not prove
- **That the loop is "general":** that's 2 task types (design→package, research→transaction), not a class.
- **Recovery in a non-Figma environment:** nothing failed.
- **Choosing between environments:** only one was realistically usable.
- **Robustness on real, messy sites:** saucedemo is built for automation (stable `data-test` attributes, no captcha, no latency tricks). The faulty accounts it offers (`problem_user`, etc.) were deliberately not used; a later benchmark could.
- **Real consequences:** no real money, no real personal data.
