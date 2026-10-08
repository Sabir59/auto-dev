// Plugin sandbox (main thread).
// Has full Figma document API. NO network access here (fetch/WebSocket are not
// available in this context) — that's why we need ui.html as the network leg.

figma.showUI(__html__, { visible: true, width: 260, height: 160 });

// --- Helpers -------------------------------------------------------------

// Every node lookup goes through here. figma.getNodeByIdAsync can fail with
// Figma's own "Unable to establish connection" error for ids that DO exist —
// observed reproducibly for instance-sublayer ids ("I<instance>;<layer>") of
// remote-library instances, while the instance itself still resolved and its
// subtree was still readable. So for those ids, fall back to resolving the
// outermost instance and walking its (already-loaded) subtree.
async function getNode(id) {
  try {
    return await figma.getNodeByIdAsync(id);
  } catch (e) {
    // Pages are reachable without a lookup — figma.root.children is local.
    const pageMatch = figma.root.children.find((p) => p.id === id);
    if (pageMatch) return pageMatch;
    if (typeof id === "string" && id.startsWith("I") && id.includes(";")) {
      const root = await figma.getNodeByIdAsync(id.slice(1, id.indexOf(";")));
      const found = root && "findOne" in root ? root.findOne((n) => n.id === id) : null;
      if (found) return found;
    }
    throw new Error(
      `Figma failed to look up ${id} (${(e && e.message) || String(e)}). This does NOT reliably mean the node is missing — check via its parent with figma_get_document_state.`
    );
  }
}

async function resolveParent(parentId) {
  if (!parentId) return figma.currentPage;
  const p = await getNode(parentId);
  if (!p || !("appendChild" in p)) throw new Error(`parentId ${parentId} is not a valid container node`);
  return p;
}

// appendChild always adds at the end — insertIndex lets a newly-created
// node land at a specific position instead (e.g. an icon that must render
// before existing text, not after it).
function appendNode(parent, node, insertIndex) {
  if (insertIndex !== undefined && insertIndex !== null) {
    parent.insertChild(Number(insertIndex), node);
  } else {
    parent.appendChild(node);
  }
}

function solidPaint(c) {
  if (!c) return null;
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a !== undefined ? c.a : 1 };
}

// Shared by CREATE_TEXT and MODIFY_NODE (on TEXT nodes) so styling logic
// only lives in one place.
async function applyTextParams(node, p) {
  if (p.font) {
    const f = { family: p.font.family || node.fontName.family, style: p.font.style || node.fontName.style };
    await figma.loadFontAsync(f);
    node.fontName = f;
  }
  if (p.fontSize !== undefined) node.fontSize = Number(p.fontSize);
  if (p.characters !== undefined) {
    await figma.loadFontAsync(node.fontName);
    node.characters = String(p.characters);
  }
  if (p.fill !== undefined) node.fills = [solidPaint(p.fill)];
  if (p.textAlignHorizontal !== undefined) node.textAlignHorizontal = p.textAlignHorizontal;
  if (p.letterSpacing !== undefined) {
    node.letterSpacing = typeof p.letterSpacing === "number" ? { value: p.letterSpacing, unit: "PIXELS" } : p.letterSpacing;
  }
  if (p.lineHeight !== undefined) {
    node.lineHeight = typeof p.lineHeight === "number" ? { value: p.lineHeight, unit: "PIXELS" } : p.lineHeight;
  }
  if (p.textCase !== undefined) node.textCase = p.textCase;
  if (p.textAutoResize !== undefined) node.textAutoResize = p.textAutoResize;
  // A fixed width only sticks if auto-resize isn't still WIDTH_AND_HEIGHT
  // (Figma's default for new text) — set width without this and Figma
  // silently keeps auto-sizing, ignoring the width.
  if (p.width !== undefined) {
    if (node.textAutoResize === "WIDTH_AND_HEIGHT") node.textAutoResize = "HEIGHT";
    node.resize(Number(p.width), node.height);
  }
}

// Shared by CREATE_FRAME/CREATE_COMPONENT and MODIFY_NODE for generic
// visual props that apply to any frame-like/rect-like node.
function applyBoxParams(node, p, applied) {
  if (p.fill !== undefined && "fills" in node) {
    node.fills = [solidPaint(p.fill)];
    applied.fill = p.fill;
  }
  if (p.cornerRadius !== undefined && "cornerRadius" in node) {
    node.cornerRadius = Number(p.cornerRadius);
    applied.cornerRadius = node.cornerRadius;
  }
  if (p.strokeColor !== undefined && "strokes" in node) {
    node.strokes = [solidPaint(p.strokeColor)];
    node.strokeWeight = p.strokeWeight !== undefined ? Number(p.strokeWeight) : 1;
    applied.stroke = true;
  }
  if (p.dropShadow !== undefined && "effects" in node) {
    if (!p.dropShadow) {
      node.effects = [];
      applied.dropShadow = false;
    } else {
      const s = p.dropShadow;
      node.effects = [
        {
          type: "DROP_SHADOW",
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a !== undefined ? s.color.a : 1 },
          offset: { x: s.x || 0, y: s.y || 0 },
          radius: s.blur || 0,
          spread: s.spread || 0,
          visible: true,
          blendMode: "NORMAL",
        },
      ];
      applied.dropShadow = true;
    }
  }
  if (p.opacity !== undefined && "opacity" in node) {
    node.opacity = Number(p.opacity);
    applied.opacity = node.opacity;
  }
}

function serializeShallow(node) {
  const base = { id: node.id, name: node.name, type: node.type };
  if ("x" in node) base.x = node.x;
  if ("y" in node) base.y = node.y;
  if ("width" in node) base.width = node.width;
  if ("height" in node) base.height = node.height;
  // .key is the stable cross-file identifier for a PUBLISHED component
  // (distinct from .id, which only means anything within this one file) —
  // needed to test whether a component can be imported into another file.
  if ("key" in node && node.key) base.key = node.key;
  if ("remote" in node) base.remote = node.remote;
  return base;
}

// figma.mixed shows up wherever a property varies across a text range or
// across a multi-corner radius — never JSON-serializable, so it must be
// caught explicitly or Figma throws when the value is touched further.
function safe(v) {
  return v === figma.mixed ? "MIXED" : v;
}

function colorToCss(color, opacity) {
  const a = opacity !== undefined ? opacity : 1;
  const hex =
    "#" +
    [color.r, color.g, color.b]
      .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
      .join("");
  return { hex, r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255), a };
}

function variableColorHex(c) {
  const a = c.a !== undefined ? c.a : 1;
  const hex = [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  return a < 1 ? `#${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}` : `#${hex}`;
}

// A variable's value under a given mode is either a literal or a
// VARIABLE_ALIAS pointing at another variable (possibly in a different
// collection, e.g. a Theme role aliasing a Primitives swatch). Resolves the
// chain to a final literal plus the immediate alias name, the way a design
// token export needs (raw value + human-readable source).
async function resolveVariableValue(rawValue, modeName, depth) {
  depth = depth || 0;
  if (rawValue && typeof rawValue === "object" && rawValue.type === "VARIABLE_ALIAS") {
    if (depth > 10) throw new Error("Variable alias chain too deep (possible cycle)");
    const aliased = await figma.variables.getVariableByIdAsync(rawValue.id);
    if (!aliased) return { alias: null, value: null };
    const aliasedCollection = await figma.variables.getVariableCollectionByIdAsync(aliased.variableCollectionId);
    const mode =
      aliasedCollection.modes.find((m) => m.name === modeName) ||
      aliasedCollection.modes.find((m) => m.modeId === aliasedCollection.defaultModeId);
    const nested = await resolveVariableValue(aliased.valuesByMode[mode.modeId], modeName, depth + 1);
    return { alias: aliased.name, value: nested.value };
  }
  return { alias: null, value: rawValue };
}

// Full style dump for the measurement-report use case: fills, strokes,
// corner radii, shadows, auto-layout padding/alignment, and (for TEXT)
// complete typography — not just geometry.
async function serializeDeep(node, depth) {
  const out = serializeShallow(node);

  if ("fills" in node && Array.isArray(node.fills) && node.fills.length) {
    out.fills = node.fills
      .filter((f) => f.visible !== false)
      .map((f) => ({
        ...(f.type === "SOLID" ? { type: "SOLID", ...colorToCss(f.color, f.opacity) } : { type: f.type }),
        // A bound variable means this fill is a live token reference, not a
        // hardcoded value — the actual question we need answered honestly.
        boundVariable: f.boundVariables && f.boundVariables.color ? f.boundVariables.color.id : null,
      }));
  }
  // fillStyleId means this fill points at a shared Paint Style (the older,
  // pre-Variables token mechanism) rather than being a one-off literal.
  if ("fillStyleId" in node && node.fillStyleId) out.fillStyleId = node.fillStyleId;
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length) {
    out.strokes = node.strokes.map((s) => (s.type === "SOLID" ? { type: "SOLID", ...colorToCss(s.color, s.opacity) } : { type: s.type }));
    out.strokeWeight = safe(node.strokeWeight);
  }
  if ("cornerRadius" in node) {
    const r = safe(node.cornerRadius);
    if (r === "MIXED") {
      out.cornerRadius = "MIXED";
      out.topLeftRadius = node.topLeftRadius;
      out.topRightRadius = node.topRightRadius;
      out.bottomLeftRadius = node.bottomLeftRadius;
      out.bottomRightRadius = node.bottomRightRadius;
    } else if (r) {
      out.cornerRadius = r;
    }
  }
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length) {
    out.effects = node.effects
      .filter((e) => e.visible !== false)
      .map((e) => ({
        type: e.type,
        color: e.color ? colorToCss(e.color, e.color.a) : undefined,
        offset: e.offset,
        radius: e.radius,
        spread: e.spread,
      }));
  }
  if ("opacity" in node && node.opacity !== 1) out.opacity = node.opacity;
  if ("visible" in node && node.visible === false) out.visible = false;

  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode;
    out.itemSpacing = node.itemSpacing;
    out.padding = { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft };
    out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    out.counterAxisAlignItems = node.counterAxisAlignItems;
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
  }

  if (node.type === "TEXT") {
    out.characters = node.characters;
    out.fontName = safe(node.fontName);
    out.fontSize = safe(node.fontSize);
    out.lineHeight = safe(node.lineHeight);
    out.letterSpacing = safe(node.letterSpacing);
    out.textAlignHorizontal = node.textAlignHorizontal;
    out.textCase = safe(node.textCase);
  }

  if (node.type === "INSTANCE") {
    // Sync mainComponent throws under documentAccess: "dynamic-page" — same
    // class of gotcha as getNodeById.
    const main = await node.getMainComponentAsync();
    out.mainComponent = main ? main.name : null;
    out.mainComponentId = main ? main.id : null; // needed to actually reuse it via CREATE_INSTANCE
  }
  if (depth > 0 && "children" in node) {
    out.children = await Promise.all(node.children.map((c) => serializeDeep(c, depth - 1)));
  }
  return out;
}

// --- Command handlers ------------------------------------------------------

// --- Compact node-tree serialization ----------------------------------
// Shared by GET_COMPONENT_TREE and GET_SCREEN_TREE: the same per-node
// shape (design/spec/components.json AND screens-*.json both use it),
// resolving fills/strokes/radius/gap/padding to their bound Variable's
// name, effects/text styles to their Style name, and component property
// bindings/overrides — instead of raw ids or literal values.

const stripSuffix = (key) => (key.includes("#") ? key.slice(0, key.indexOf("#")) : key);

async function resolveBoundVar(node, field) {
  const bv = node.boundVariables && node.boundVariables[field];
  if (!bv) return null;
  const alias = Array.isArray(bv) ? bv[0] : bv;
  if (!alias || !alias.id) return null;
  const v = await figma.variables.getVariableByIdAsync(alias.id);
  return v ? v.name : null;
}

async function styleName(styleId) {
  if (!styleId) return null;
  const s = await figma.getStyleByIdAsync(styleId);
  return s ? s.name : null;
}

async function describeLayout(node, out) {
  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    const gapVar = await resolveBoundVar(node, "itemSpacing");
    const padTopVar = await resolveBoundVar(node, "paddingTop");
    const padRightVar = await resolveBoundVar(node, "paddingRight");
    const padBottomVar = await resolveBoundVar(node, "paddingBottom");
    const padLeftVar = await resolveBoundVar(node, "paddingLeft");
    out.layout = {
      dir: node.layoutMode === "HORIZONTAL" ? "row" : "col",
      gap: gapVar || node.itemSpacing,
      pad: [padTopVar || node.paddingTop, padRightVar || node.paddingRight, padBottomVar || node.paddingBottom, padLeftVar || node.paddingLeft],
      main: node.primaryAxisAlignItems,
      cross: node.counterAxisAlignItems,
    };
  }
  if ("layoutSizingHorizontal" in node && node.layoutSizingHorizontal && node.layoutSizingHorizontal !== "NONE") {
    out.size = `${node.layoutSizingHorizontal}/${node.layoutSizingVertical}`;
  }
  // A child pulled out of its parent's auto-layout flow (e.g. a status
  // bar pinned to the top, a home indicator pinned to the bottom) keeps
  // its own x/y as an offset from the parent's origin — not meaningful
  // to compare against flow-positioned siblings, so kept as its own field.
  if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") {
    out.abs = [Math.round(node.x), Math.round(node.y)];
  }
}

async function resolveFillOrStroke(paint) {
  if (!paint || paint.type !== "SOLID") return null;
  const bv = paint.boundVariables && paint.boundVariables.color;
  if (bv) {
    const v = await figma.variables.getVariableByIdAsync(bv.id);
    if (v) return v.name;
  }
  return variableColorHex(paint.color); // raw hex = not tokenized
}

async function describeVisuals(node, out) {
  if ("cornerRadius" in node && node.cornerRadius !== undefined) {
    // Figma stores a radius binding per-corner even when all four corners
    // share one value/variable — topLeftRadius is a stand-in for "the"
    // uniform binding. Try that FIRST: a bottom sheet with only its top
    // corners rounded (top bound to a token, bottom literal 0) reads as
    // cornerRadius === figma.mixed, but still has a real, meaningful token
    // on topLeftRadius — only fall back to a bare "MIXED"/raw-number
    // reading when no corner is actually tokenized.
    const rVar = await resolveBoundVar(node, "topLeftRadius");
    if (rVar) {
      out.radius = rVar;
    } else if (node.cornerRadius === figma.mixed) {
      out.radius = "MIXED";
    } else if (node.cornerRadius) {
      out.radius = node.cornerRadius;
    }
  }
  if ("fills" in node && Array.isArray(node.fills) && node.fills.length) {
    const f = node.fills.find((x) => x.visible !== false);
    if (f) out.fill = await resolveFillOrStroke(f);
  }
  if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length) {
    const name = await resolveFillOrStroke(node.strokes[0]);
    // A node with independently-set per-side stroke weights reports
    // strokeWeight as figma.mixed (a Symbol) — rendered as "" (matching
    // the reference's own convention) rather than invented text.
    const weight = typeof node.strokeWeight === "number" ? node.strokeWeight : "";
    const dashed = Array.isArray(node.dashPattern) && node.dashPattern.length ? " dashed" : "";
    if (name) out.stroke = `${name} ${weight}${dashed}`;
  }
  if ("effectStyleId" in node && node.effectStyleId) {
    out.effect = await styleName(node.effectStyleId);
  }
  if ("opacity" in node && node.opacity !== undefined && node.opacity !== 1) {
    out.opacity = node.opacity;
  }
}

async function describeInstance(node, out) {
  const main = await node.getMainComponentAsync();
  const setParent = main && main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
  const compName = setParent ? setParent.name : main ? main.name : null;
  const variantProps = node.variantProperties || {};
  const variantStr = Object.entries(variantProps)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  out.comp = variantStr ? `${compName} {${variantStr}}` : compName;

  const props = {};
  if (node.componentProperties) {
    for (const [key, def] of Object.entries(node.componentProperties)) {
      if (def.type === "VARIANT") continue;
      if (def.type === "INSTANCE_SWAP" && def.value) {
        const swapped = await getNode(def.value);
        props[stripSuffix(key)] = swapped ? swapped.name : def.value;
      } else {
        props[stripSuffix(key)] = def.value;
      }
    }
  }
  out.props = props; // always present, even {} — matches the reference format
}

async function describeNode(node) {
  const out = { n: node.name, t: node.type.toLowerCase() };
  if ("width" in node) {
    out.w = Math.round(node.width);
    out.h = Math.round(node.height);
  }
  await describeLayout(node, out);
  await describeVisuals(node, out);

  if (node.componentPropertyReferences && Object.keys(node.componentPropertyReferences).length) {
    out.bind = Object.fromEntries(Object.entries(node.componentPropertyReferences).map(([k, v]) => [k, stripSuffix(v)]));
  }

  if (node.type === "TEXT") {
    out.text = {
      style: await styleName(node.textStyleId),
      color: out.fill,
      align: node.textAlignHorizontal,
      value: node.characters,
    };
    delete out.fill;
  }

  if (node.type === "INSTANCE") {
    await describeInstance(node, out);
  }

  // An instance's internal structure is already fully described once, at
  // its master component — repeating it at every use site would just be
  // noise. A hidden-by-default child (visible:false, e.g. an optional
  // image bound to a boolean prop that defaults off) is left out of the
  // default tree too; its existence is still implied by the sibling
  // `bind` reference + that prop's default value.
  if (node.type !== "INSTANCE" && "children" in node && node.children && node.children.length) {
    const visibleKids = node.children.filter((c) => c.visible !== false);
    if (visibleKids.length) {
      out.kids = [];
      for (const child of visibleKids) out.kids.push(await describeNode(child));
    }
  }
  return out;
}

async function buildPropsOut(defs) {
  const props = {};
  if (!defs) return props;
  for (const [key, def] of Object.entries(defs)) {
    const clean = stripSuffix(key);
    if (def.type === "VARIANT") {
      props[clean] = { type: "variant", default: def.defaultValue, options: def.variantOptions };
    } else if (def.type === "INSTANCE_SWAP" && def.defaultValue) {
      const swapped = await getNode(def.defaultValue);
      props[clean] = { type: "instance_swap", default: swapped ? swapped.name : def.defaultValue };
    } else {
      props[clean] = { type: def.type.toLowerCase(), default: def.defaultValue };
    }
  }
  return props;
}

const handlers = {
  PING: async () => ({ pong: true, time: Date.now() }),

  // Establishes which file the Executor is actually connected to — meant to
  // be checked before assuming, not trusted blindly. figma.fileKey is
  // documented as restricted to private/Figma-owned plugins regardless of
  // the enablePrivatePluginApi manifest flag; we set the flag and report
  // whatever actually comes back rather than assume it works.
  GET_FILE_INFO: async () => ({
    fileName: figma.root.name,
    fileKey: figma.fileKey, // expected to be undefined for this plugin — see comment above
    editorType: figma.editorType,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    rootId: figma.root.id,
  }),

  // Tests Figma's own real cross-file mechanism directly — not a
  // workaround. Only works if the source component was actually published
  // to a team library; throws otherwise, and we report that honestly
  // rather than catching/hiding it.
  // Binds an existing fill to a real Figma Variable instead of a literal
  // value — tests whether the variable is reachable at all, and whether a
  // NEW paint can actually bind to it (not just read it).
  BIND_VARIABLE_TO_FILL: async (params) => {
    const { id, variableId, fillIndex } = params;
    const node = await getNode(id);
    if (!node || !("fills" in node)) throw new Error(`${id} has no fills`);
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (!variable) throw new Error(`Variable ${variableId} not found or not accessible from this file`);

    const idx = fillIndex || 0;
    const fills = node.fills.map((f, i) => (i === idx ? figma.variables.setBoundVariableForPaint(f, "color", variable) : f));
    node.fills = fills;

    return {
      variableName: variable.name,
      variableId: variable.id,
      collectionId: variable.variableCollectionId,
      summary: `SUCCESS: Bound fill[${idx}] of ${id} to variable "${variable.name}"`,
    };
  },

  // Reads a COMPONENT or COMPONENT_SET as design/spec/components.json's
  // compact tree shape: name/props/variants, each variant's tree with
  // layout (dir/gap/pad/main/cross), size (FIXED/HUG/FILL per axis),
  // fill/stroke/radius/effect resolved to token or style NAMES (not raw
  // values or ids) wherever bound, TEXT style/color/align/value, and
  // `bind` (componentPropertyReferences — which prop drives a layer).
  // Recurses into every child. General — no app-specific assumptions.
  GET_COMPONENT_TREE: async (params) => {
    let node = await getNode(params.id);
    if (!node) throw new Error(`Node not found: ${params.id}`);
    // A variant can't be described on its own — Figma forbids reading
    // componentPropertyDefinitions on it — and an instance's mainComponentId
    // is usually a variant. Describe its whole set instead.
    if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") node = node.parent;

    if (node.type === "COMPONENT_SET") {
      const props = await buildPropsOut(node.componentPropertyDefinitions);
      const variants = [];
      for (const child of node.children) {
        variants.push({ variant: child.name, tree: await describeNode(child) });
      }
      return { name: node.name, description: node.description || undefined, props, variants };
    }
    if (node.type === "COMPONENT") {
      const props = await buildPropsOut(node.componentPropertyDefinitions);
      const tree = await describeNode(node);
      return { name: node.name, description: node.description || undefined, props, variants: [{ variant: "default", tree }] };
    }
    throw new Error(`${params.id} is not a COMPONENT or COMPONENT_SET (got ${node.type})`);
  },

  // Reads every prototype reaction on every top-level screen FRAME of a
  // page — design/spec/prototype.json's shape: {flows, screens}. `flows`
  // is the page's real flowStartingPoints (Figma's own "where does this
  // prototype start" markers). Each reaction becomes {on, trigger,
  // action, to, transition}: `on` is a " › "-joined breadcrumb from the
  // screen root down to (and including) the reacting layer; `to` is
  // either the destination screen's name (NAVIGATE) or, for a variant
  // swap (a component's own name + its parent set's name, since the
  // destination of a SWAP is a bare variant, not an instance).
  GET_PROTOTYPE: async (params) => {
    const page = await getNode(params.pageId);
    if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page`);

    async function destinationLabel(destId) {
      const dest = await getNode(destId);
      if (!dest) return null;
      if (dest.type === "COMPONENT" && dest.parent && dest.parent.type === "COMPONENT_SET") {
        return `${dest.parent.name} {${dest.name}}`;
      }
      return dest.name;
    }

    function transitionLabel(t) {
      if (!t) return "instant";
      const type = t.type.toLowerCase();
      // Figma stores duration as a 32-bit float internally, so reading it
      // back as a JS double surfaces artifacts like 0.30000001192092896
      // for what was actually entered as 0.3 — round to 3dp to undo that.
      const duration = t.duration !== undefined ? Math.round(t.duration * 1000) / 1000 : undefined;
      return duration !== undefined ? `${type} ${duration}s` : type;
    }

    const NAV_ACTION = { NAVIGATE: "navigate", SWAP: "change_to", OVERLAY: "overlay", SCROLL_TO: "scroll_to" };

    async function reactionEntries(node, path) {
      const out = [];
      if (node.reactions && node.reactions.length) {
        const on = path.join(" › ");
        for (const r of node.reactions) {
          const trigger = r.trigger ? r.trigger.type.toLowerCase() : null;
          const actions = r.actions || (r.action ? [r.action] : []);
          for (const a of actions) {
            let action, to, transition;
            if (a.type === "NODE") {
              action = NAV_ACTION[a.navigation] || a.navigation.toLowerCase();
              to = a.destinationId ? await destinationLabel(a.destinationId) : null;
              transition = transitionLabel(a.transition);
            } else if (a.type === "BACK") {
              action = "back";
            } else if (a.type === "CLOSE") {
              action = "close overlay";
            } else {
              action = a.type.toLowerCase();
            }
            out.push({ on, trigger, action, to, transition });
          }
        }
      }
      if ("children" in node && node.children) {
        for (const child of node.children) out.push(...(await reactionEntries(child, [...path, child.name])));
      }
      return out;
    }

    const flows = (page.flowStartingPoints || []).map((f) => ({ nodeId: f.nodeId, name: f.name }));
    const screens = {};
    for (const frame of page.children) {
      if (frame.type !== "FRAME" && frame.type !== "COMPONENT") continue;
      const entries = [];
      for (const child of frame.children || []) entries.push(...(await reactionEntries(child, [child.name])));
      if (entries.length) screens[frame.name] = entries;
    }
    return { flows, screens };
  },

  // Reads a screen FRAME into design/spec/screens-*.json's shape: the
  // same compact tree describeNode/GET_COMPONENT_TREE uses, just wrapped
  // as {name, originalName, tree} instead of {name, props, variants}.
  GET_SCREEN_TREE: async (params) => {
    const node = await getNode(params.id);
    if (!node) throw new Error(`Node not found: ${params.id}`);
    if (node.type !== "FRAME" && node.type !== "COMPONENT") throw new Error(`${params.id} is not a FRAME (got ${node.type})`);
    return { name: node.name, originalName: node.name, tree: await describeNode(node) };
  },

  // Finds every COMPONENT whose name starts with a prefix (default
  // "icon/") anywhere on one page, and derives the PascalCase name an icon
  // library (Lucide, etc.) would use for it — a pure naming transform, not
  // a lookup table, so it works for any icon set with kebab-case names.
  // Whether that PascalCase name actually exists in a real icon library is
  // for the caller to check (has network access; the plugin sandbox doesn't).
  GET_ICON_COMPONENTS: async (params) => {
    const { pageId, prefix } = params || {};
    const pfx = prefix || "icon/";
    let root;
    if (pageId) {
      root = await getNode(pageId);
      if (!root || root.type !== "PAGE") throw new Error(`${pageId} is not a page`);
      await root.loadAsync();
    } else {
      root = figma.currentPage;
    }
    const kebabToPascal = (s) => s.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    const matches = root.findAll((node) => node.type === "COMPONENT" && node.name.startsWith(pfx));
    const icons = matches.map((node) => ({
      id: node.id,
      key: node.key,
      figmaName: node.name,
      suggestedComponentName: kebabToPascal(node.name.slice(pfx.length)),
    }));
    return { count: icons.length, icons };
  },

  // Reads local text/effect/grid styles (design/spec/typography.json's
  // shape) — the other half of "tokens" that lives in Figma Styles rather
  // than Variables. General — no app-specific field names.
  GET_STYLES: async () => {
    const textStylesRaw = await figma.getLocalTextStylesAsync();
    const effectStylesRaw = await figma.getLocalEffectStylesAsync();
    const gridStylesRaw = await figma.getLocalGridStylesAsync();

    const fmtDimension = (d) => {
      if (!d) return undefined;
      if (d.unit === "AUTO") return "AUTO";
      if (d.unit === "PERCENT") return `${d.value}%`;
      return d.value;
    };

    const textStyles = [];
    for (const s of textStylesRaw) {
      let fontVariable;
      const bv = s.boundVariables && s.boundVariables.fontFamily;
      if (bv) {
        const v = await figma.variables.getVariableByIdAsync(bv.id);
        if (v) fontVariable = v.name;
      }
      textStyles.push({
        name: s.name,
        family: s.fontName.family,
        weight: s.fontName.style,
        size: s.fontSize,
        lineHeight: fmtDimension(s.lineHeight),
        letterSpacing: fmtDimension(s.letterSpacing),
        textCase: s.textCase,
        fontVariable,
        description: s.description || undefined,
      });
    }

    const effectStyles = effectStylesRaw.map((s) => ({
      name: s.name,
      description: s.description || undefined,
      effects: s.effects
        .filter((e) => e.visible !== false)
        .map((e) => ({
          type: e.type,
          x: e.offset ? e.offset.x : undefined,
          y: e.offset ? e.offset.y : undefined,
          blur: e.radius,
          spread: e.spread,
          color: e.color ? variableColorHex(e.color) : undefined,
        })),
    }));

    const gridStyles = gridStylesRaw.map((s) => ({
      name: s.name,
      description: s.description || undefined,
      grids: s.layoutGrids.map((g) => ({
        pattern: g.pattern,
        visible: g.visible,
        color: g.color,
        gutterSize: g.gutterSize,
        alignment: g.alignment,
        count: g.count,
        offset: g.offset,
        sectionSize: g.sectionSize,
        boundVariables: g.boundVariables || {},
      })),
    }));

    return { textStyles, effectStyles, gridStyles };
  },

  // Reads every local Variable collection (tokens: color/float/string/
  // boolean), resolving alias chains to a final literal per mode. General
  // design-token export — not specific to any one app's naming scheme.
  GET_VARIABLES: async () => {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const out = [];
    for (const col of collections) {
      const modes = col.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
      const variables = [];
      for (const varId of col.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(varId);
        if (!v) continue;
        const valuesByMode = {};
        for (const m of col.modes) {
          const raw = v.valuesByMode[m.modeId];
          const resolved = await resolveVariableValue(raw, m.name);
          let value = resolved.value;
          if (v.resolvedType === "COLOR" && value && typeof value === "object") value = variableColorHex(value);
          valuesByMode[m.name] = { value, alias: resolved.alias || undefined };
        }
        variables.push({
          id: v.id,
          key: v.key,
          name: v.name,
          type: v.resolvedType.toLowerCase(),
          description: v.description || undefined,
          codeSyntax: v.codeSyntax && Object.keys(v.codeSyntax).length ? v.codeSyntax : undefined,
          remote: v.remote,
          valuesByMode,
        });
      }
      out.push({ id: col.id, name: col.name, modes, defaultModeId: col.defaultModeId, variables });
    }
    return { collections: out };
  },

  IMPORT_COMPONENT_BY_KEY: async (params) => {
    const { key, parentId, x, y } = params;
    if (!key) throw new Error("IMPORT_COMPONENT_BY_KEY requires params.key");
    const comp = await figma.importComponentByKeyAsync(key); // throws on failure — not caught here on purpose
    const instance = comp.createInstance();
    const parent = await resolveParent(parentId);
    parent.appendChild(instance);
    instance.x = Number(x) || 0;
    instance.y = Number(y) || 0;
    return {
      componentId: comp.id,
      componentName: comp.name,
      remote: comp.remote,
      instanceId: instance.id,
      summary: `SUCCESS: Imported component "${comp.name}" by key and created an instance`,
    };
  },

  // Minimal search: name / text-content substring match, optional type
  // filter, optional page scope. Not a query language — deliberately just
  // enough to stop dumping whole subtrees and grepping them client-side.
  SEARCH_NODES: async (params) => {
    const { query, type, pageId, limit } = params || {};
    let root;
    if (pageId) {
      root = await getNode(pageId);
      if (!root || root.type !== "PAGE") throw new Error(`${pageId} is not a page`);
      await root.loadAsync();
    } else {
      root = figma.currentPage;
    }

    const q = (query || "").toLowerCase();
    const cap = limit || 50;

    const matches = root.findAll((node) => {
      if (type && node.type !== type) return false;
      if (!q) return true;
      const nameMatch = node.name && node.name.toLowerCase().includes(q);
      const textMatch = node.type === "TEXT" && node.characters && node.characters.toLowerCase().includes(q);
      return nameMatch || textMatch;
    });

    const results = [];
    for (const node of matches.slice(0, cap)) {
      const entry = serializeShallow(node);
      if (node.type === "TEXT") entry.characters = node.characters;
      if (node.type === "INSTANCE") {
        const main = await node.getMainComponentAsync();
        entry.mainComponent = main ? main.name : null;
        entry.mainComponentId = main ? main.id : null;
      }
      results.push(entry);
    }

    return {
      totalMatches: matches.length,
      returned: results.length,
      truncated: matches.length > cap,
      nodes: results,
    };
  },

  DELETE_NODE: async (params) => {
    const node = await getNode(params.id);
    if (!node) return { deleted: false, summary: `Node ${params.id} already gone` };
    const name = node.name;
    node.remove();
    return { deleted: true, summary: `SUCCESS: Deleted node "${name}"` };
  },

  GET_SELECTION: async () => {
    const sel = figma.currentPage.selection;
    return { count: sel.length, nodes: sel.map(serializeShallow) };
  },

  CREATE_FRAME: async (params) => {
    const parent = await resolveParent(params.parentId);
    const frame = figma.createFrame();
    frame.resize(Number(params.width) || 100, Number(params.height) || 100);
    frame.name = params.name || "Frame";
    frame.x = Number(params.x) || 0;
    frame.y = Number(params.y) || 0;
    const applied = {};
    applyBoxParams(frame, params, applied);
    appendNode(parent, frame, params.insertIndex);
    return {
      id: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      summary: `SUCCESS: Created frame "${frame.name}", ${frame.width}x${frame.height}`,
    };
  },

  CREATE_COMPONENT: async (params) => {
    const parent = await resolveParent(params.parentId);
    const comp = figma.createComponent();
    comp.resize(Number(params.width) || 100, Number(params.height) || 100);
    comp.name = params.name || "Component";
    comp.x = Number(params.x) || 0;
    comp.y = Number(params.y) || 0;
    const applied = {};
    applyBoxParams(comp, params, applied);
    appendNode(parent, comp, params.insertIndex);
    return { id: comp.id, name: comp.name, summary: `SUCCESS: Created component "${comp.name}"` };
  },

  CREATE_TEXT: async (params) => {
    const parent = await resolveParent(params.parentId);
    const family = (params.font && params.font.family) || params.fontFamily || "Inter";
    const style = (params.font && params.font.style) || params.fontStyle || "Regular";
    await figma.loadFontAsync({ family, style });

    const text = figma.createText();
    text.fontName = { family, style };
    if (params.fontSize) text.fontSize = Number(params.fontSize);
    text.characters = params.content != null ? String(params.content) : "";
    text.x = Number(params.x) || 0;
    text.y = Number(params.y) || 0;

    await applyTextParams(text, params);
    // Figma auto-names new text nodes by their content — must set this
    // explicitly, or a caller-supplied params.name is silently dropped.
    if (params.name) text.name = params.name;
    appendNode(parent, text, params.insertIndex);

    return {
      id: text.id,
      name: text.name,
      characters: text.characters,
      summary: `SUCCESS: Created text "${text.characters}"`,
    };
  },

  // Stroke-based vector icon from raw SVG path data (e.g. Feather/Lucide-style
  // 24x24 icons). Uses figma.createVector + vectorPaths rather than any SVG
  // import helper, since that's the one guaranteed-stable primitive for this.
  CREATE_VECTOR: async (params) => {
    const parent = await resolveParent(params.parentId);
    const vector = figma.createVector();
    vector.name = params.name || "Icon";
    vector.vectorPaths = [{ windingRule: params.windingRule || "NONZERO", data: params.path }];

    if (params.strokeColor) {
      vector.strokes = [solidPaint(params.strokeColor)];
      vector.strokeWeight = params.strokeWeight || 2;
      vector.strokeCap = params.strokeCap || "ROUND";
      vector.strokeJoin = params.strokeJoin || "ROUND";
      vector.fills = [];
    } else if (params.fillColor) {
      vector.fills = [solidPaint(params.fillColor)];
      vector.strokes = [];
    }

    if (params.width || params.height) {
      vector.resize(Number(params.width) || vector.width, Number(params.height) || vector.height);
    }
    vector.x = Number(params.x) || 0;
    vector.y = Number(params.y) || 0;

    appendNode(parent, vector, params.insertIndex);
    return {
      id: vector.id,
      name: vector.name,
      width: vector.width,
      height: vector.height,
      summary: `SUCCESS: Created vector icon "${vector.name}"`,
    };
  },

  // A true circle (e.g. an icon's head, an avatar) — createVector can only
  // approximate one with beziers; this is exact.
  // Instances can't have children added/removed (confirmed by direct
  // failure earlier) — detach breaks the component link so the node
  // becomes a plain, freely-editable frame, at the cost of no longer
  // tracking the master component.
  DETACH_INSTANCE: async (params) => {
    const node = await getNode(params.id);
    if (!node || node.type !== "INSTANCE") throw new Error(`${params.id} is not an instance`);
    const detached = node.detachInstance();
    return { id: detached.id, name: detached.name, summary: `SUCCESS: Detached "${detached.name}" from its component` };
  },

  // The design system's own override path: an instance's TEXT, BOOLEAN,
  // INSTANCE_SWAP (value = a COMPONENT id) and VARIANT properties — instead
  // of reaching into nested layers (e.g. toggling a layer's visibility that a
  // boolean property already controls). Names may omit Figma's "#id" suffix.
  SET_INSTANCE_PROPERTIES: async (params) => {
    const node = await getNode(params.id);
    if (!node || node.type !== "INSTANCE") throw new Error(`${params.id} is not an instance`);
    const current = node.componentProperties;
    const update = {};
    for (const [name, value] of Object.entries(params.properties || {})) {
      const key = Object.keys(current).find((k) => k === name || stripSuffix(k) === name);
      if (!key) {
        throw new Error(`"${node.name}" has no component property "${name}". Available: ${Object.keys(current).map(stripSuffix).join(", ")}`);
      }
      update[key] = value;
    }
    node.setProperties(update);

    const properties = {};
    for (const [key, def] of Object.entries(node.componentProperties)) {
      if (def.type === "INSTANCE_SWAP" && def.value) {
        const swapped = await getNode(def.value);
        properties[stripSuffix(key)] = swapped ? swapped.name : def.value;
      } else {
        properties[stripSuffix(key)] = def.value;
      }
    }
    return { id: node.id, name: node.name, properties, summary: `SUCCESS: Set ${Object.keys(update).join(", ")} on "${node.name}"` };
  },

  CREATE_ELLIPSE: async (params) => {
    const parent = await resolveParent(params.parentId);
    const ellipse = figma.createEllipse();
    ellipse.name = params.name || "Ellipse";
    ellipse.resize(Number(params.width) || 20, Number(params.height) || 20);
    if (params.strokeColor) {
      ellipse.strokes = [solidPaint(params.strokeColor)];
      ellipse.strokeWeight = params.strokeWeight || 2;
      ellipse.fills = [];
    } else if (params.fillColor) {
      ellipse.fills = [solidPaint(params.fillColor)];
      ellipse.strokes = [];
    }
    ellipse.x = Number(params.x) || 0;
    ellipse.y = Number(params.y) || 0;
    appendNode(parent, ellipse, params.insertIndex);
    return { id: ellipse.id, name: ellipse.name, summary: `SUCCESS: Created ellipse "${ellipse.name}"` };
  },

  CREATE_INSTANCE: async (params) => {
    const comp = await getNode(params.componentId);
    if (!comp || comp.type !== "COMPONENT") throw new Error(`componentId ${params.componentId} is not a component`);
    const parent = await resolveParent(params.parentId);
    const instance = comp.createInstance();
    if (params.name) instance.name = params.name;
    instance.x = Number(params.x) || 0;
    instance.y = Number(params.y) || 0;
    parent.appendChild(instance);
    return {
      id: instance.id,
      name: instance.name,
      // Shallow tree of children (2 levels) so the caller can find e.g. a
      // nested "Label" text node's id to override via MODIFY_NODE, without
      // an extra round-trip.
      children: instance.children.map((c) => ({
        ...serializeShallow(c),
        children: "children" in c ? c.children.map(serializeShallow) : undefined,
      })),
      summary: `SUCCESS: Created instance "${instance.name}" of "${comp.name}"`,
    };
  },

  // Merge several single-variant components into one component set. Each
  // source component's name must already follow Figma's "Prop=Value"
  // convention (e.g. "Style=Primary") — that's how Figma derives the variant
  // property, there's no separate API for naming it.
  COMBINE_AS_VARIANTS: async (params) => {
    const nodes = [];
    for (const id of params.componentIds) {
      const n = await getNode(id);
      if (!n || n.type !== "COMPONENT") throw new Error(`componentIds must all be COMPONENT nodes; ${id} is not`);
      nodes.push(n);
    }
    const parent = await resolveParent(params.parentId);
    const set = figma.combineAsVariants(nodes, parent);
    if (params.name) set.name = params.name;
    return { id: set.id, name: set.name, summary: `SUCCESS: Combined ${nodes.length} components into variant set "${set.name}"` };
  },

  SET_AUTO_LAYOUT: async (params) => {
    const node = await getNode(params.id);
    if (!node || !("layoutMode" in node)) throw new Error(`Node ${params.id} does not support auto layout`);

    node.layoutMode = params.layoutMode || "VERTICAL";
    if (params.itemSpacing !== undefined) node.itemSpacing = Number(params.itemSpacing);
    const pad = params.padding || {};
    if (params.paddingAll !== undefined) {
      node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = Number(params.paddingAll);
    }
    if (pad.top !== undefined) node.paddingTop = Number(pad.top);
    if (pad.right !== undefined) node.paddingRight = Number(pad.right);
    if (pad.bottom !== undefined) node.paddingBottom = Number(pad.bottom);
    if (pad.left !== undefined) node.paddingLeft = Number(pad.left);
    if (params.primaryAxisAlignItems) node.primaryAxisAlignItems = params.primaryAxisAlignItems;
    if (params.counterAxisAlignItems) node.counterAxisAlignItems = params.counterAxisAlignItems;
    if (params.primaryAxisSizingMode) node.primaryAxisSizingMode = params.primaryAxisSizingMode;
    if (params.counterAxisSizingMode) node.counterAxisSizingMode = params.counterAxisSizingMode;
    if (params.layoutWrap) node.layoutWrap = params.layoutWrap;

    return { id: node.id, summary: `SUCCESS: Applied auto layout to ${node.id}` };
  },

  MODIFY_NODE: async (params) => {
    const { id, props } = params;
    if (!id) throw new Error("MODIFY_NODE requires params.id");

    // getNodeById() throws under documentAccess: "dynamic-page" — must use
    // the async lookup instead.
    const node = await getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const applied = {};

    if (props.parentId !== undefined) {
      const newParent = await getNode(props.parentId);
      if (!newParent || !("appendChild" in newParent)) {
        throw new Error(`parentId ${props.parentId} is not a valid container node`);
      }
      // insertIndex lets a reparented node land at a specific position
      // (e.g. "first child") — appendChild always adds at the end, which
      // silently breaks intended visual order (icon-before-text, etc.).
      if (props.insertIndex !== undefined && "insertChild" in newParent) {
        newParent.insertChild(Number(props.insertIndex), node);
      } else {
        newParent.appendChild(node); // reparents; x/y become relative to newParent
      }
      applied.parentId = newParent.id;
    }
    if (props.layoutPositioning !== undefined && "layoutPositioning" in node) {
      // Must happen BEFORE x/y: while a node is still flow-managed (the
      // default), Figma recomputes its position and silently discards any
      // manual x/y set here. Only once it's "ABSOLUTE" do manual x/y stick.
      node.layoutPositioning = props.layoutPositioning;
      applied.layoutPositioning = props.layoutPositioning;
    }
    if (props.name !== undefined) {
      node.name = String(props.name);
      applied.name = node.name;
    }
    if (props.x !== undefined && "x" in node) {
      node.x = Number(props.x);
      applied.x = node.x;
    }
    if (props.y !== undefined && "y" in node) {
      node.y = Number(props.y);
      applied.y = node.y;
    }
    if ((props.width !== undefined || props.height !== undefined) && "resize" in node) {
      const w = props.width !== undefined ? Number(props.width) : node.width;
      const h = props.height !== undefined ? Number(props.height) : node.height;
      node.resize(w, h);
      applied.width = node.width;
      applied.height = node.height;
    }
    if (props.visible !== undefined) {
      node.visible = !!props.visible;
      applied.visible = node.visible;
    }
    if (props.layoutGrow !== undefined && "layoutGrow" in node) {
      node.layoutGrow = Number(props.layoutGrow);
      applied.layoutGrow = node.layoutGrow;
    }
    if (props.layoutSizingHorizontal !== undefined && "layoutSizingHorizontal" in node) {
      node.layoutSizingHorizontal = props.layoutSizingHorizontal;
      applied.layoutSizingHorizontal = props.layoutSizingHorizontal;
    }
    if (props.layoutSizingVertical !== undefined && "layoutSizingVertical" in node) {
      node.layoutSizingVertical = props.layoutSizingVertical;
      applied.layoutSizingVertical = props.layoutSizingVertical;
    }
    applyBoxParams(node, props, applied);

    // Raw Figma paints (gradients, multiple layers) — applyBoxParams only
    // knows a single solid colour.
    if (props.fills !== undefined && "fills" in node) {
      node.fills = props.fills;
      applied.fills = props.fills.length;
    }
    // Reuse another node's fills (e.g. an existing photo's IMAGE paint, whose
    // imageHash isn't otherwise reachable). The source is only read.
    if (props.copyFillsFrom !== undefined && "fills" in node) {
      const src = await getNode(props.copyFillsFrom);
      if (!src || !("fills" in src) || src.fills === figma.mixed) throw new Error(`copyFillsFrom ${props.copyFillsFrom} has no copyable fills`);
      node.fills = src.fills.map((f) => (f.type === "IMAGE" ? Object.assign({}, f, { scaleMode: "FILL" }) : f));
      applied.copyFillsFrom = src.id;
    }

    if (node.type === "TEXT") {
      await applyTextParams(node, props);
      Object.assign(applied, {
        characters: props.characters,
        fontSize: props.fontSize,
        font: props.font,
      });
    }

    return {
      id: node.id,
      name: node.name,
      applied,
      summary: `SUCCESS: Modified node ${node.id} (${Object.keys(applied).join(", ") || "no-op"})`,
    };
  },

  // Default (no id): shallow list of top-level nodes on the current page.
  // With id+depth: a recursive subtree, for verifying nested structure
  // (auto layout, component instances, text content) after building it.
  // Lists every page in the document (name + id only — cheap, doesn't load
  // page contents). The starting point for "search the document" tasks.
  LIST_PAGES: async () => {
    const pages = figma.root.children.map((p) => ({ id: p.id, name: p.name }));
    return { count: pages.length, pages };
  },

  // Under dynamic-page access, only the current page's nodes are eagerly
  // available — any other page needs loading first. page.loadAsync() can
  // do that read-only, but has been unreliable here right after a plugin
  // reload; figma.setCurrentPageAsync (the same operation Figma's own UI
  // does when a human clicks a page tab) is the more robust path, so
  // scripts that need a specific page loaded should switch to it first
  // instead of relying on a human to click it.
  SWITCH_PAGE: async (params) => {
    const page = await getNode(params.pageId);
    if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page`);
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name, summary: `SUCCESS: switched to page "${page.name}"` };
  },

  CREATE_PAGE: async (params) => {
    const page = figma.createPage();
    if (params && params.name) page.name = params.name;
    return { id: page.id, name: page.name, summary: `SUCCESS: Created page "${page.name}"` };
  },

  RENAME_PAGE: async (params) => {
    const page = await getNode(params.id);
    if (!page || page.type !== "PAGE") throw new Error(`${params.id} is not a page`);
    page.name = params.name;
    return { id: page.id, name: page.name, summary: `SUCCESS: Renamed page to "${page.name}"` };
  },

  GET_DOCUMENT_STATE: async (params) => {
    if (params && params.id) {
      const node = await getNode(params.id);
      if (!node) throw new Error(`Node not found: ${params.id}`);
      return { node: await serializeDeep(node, params.depth || 4) };
    }
    if (params && params.pageId) {
      // Inspect a page other than the one currently open, without
      // switching the user's view — pages must be explicitly loaded
      // before their .children is readable.
      const page = await getNode(params.pageId);
      if (!page || page.type !== "PAGE") throw new Error(`${params.pageId} is not a page`);
      await page.loadAsync();
      const nodes = page.children.map(serializeShallow);
      return { page: page.name, count: nodes.length, nodes };
    }
    const nodes = figma.currentPage.children.map(serializeShallow);
    return { page: figma.currentPage.name, count: nodes.length, nodes };
  },

  // Renders a node to PNG and hands the raw bytes to ui.html (the only
  // context with the browser APIs needed to base64-encode and ship it over
  // the WebSocket) — see the `__binaryBytes` handling in ui.html.
  EXPORT_NODE: async (params) => {
    const node = await getNode(params.id);
    if (!node) throw new Error(`Node not found: ${params.id}`);
    const format = (params.format || "PNG").toUpperCase();
    // Only raster formats take a scale constraint — SVG/PDF are vector,
    // Figma rejects a constraint object for them.
    const settings = format === "PNG" || format === "JPG" ? { format, constraint: { type: "SCALE", value: params.scale || 2 } } : { format };
    const bytes = await node.exportAsync(settings);
    return {
      __binaryBytes: Array.from(bytes),
      format,
      width: node.width,
      height: node.height,
    };
  },
};

// --- Message dispatch ------------------------------------------------------

figma.ui.onmessage = async (msg) => {
  const { id, type, params } = msg || {};
  const handler = handlers[type];

  if (!handler) {
    figma.ui.postMessage({ id, ok: false, error: `Unknown command type: ${type}` });
    return;
  }

  try {
    const result = await handler(params || {});
    figma.ui.postMessage({ id, ok: true, result });
  } catch (err) {
    figma.ui.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
