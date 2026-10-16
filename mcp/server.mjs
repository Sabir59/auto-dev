#!/usr/bin/env node
// Thin MCP adapter over the existing Figma Executor bridge.
//
//   MCP client (Claude Code) --stdio--> this process --HTTP--> bridge/server.js --WS--> Figma plugin
//
// This file owns ZERO Figma logic. Every tool call is a straight POST of
// {type, params} to the bridge's existing /command endpoint, and the
// bridge's JSON result comes back as the tool result — same contract the
// curl-based workflow already used. If a tool is missing or wrong, the fix
// belongs in plugin/code.js (the real capability), not here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.FIGMA_BRIDGE_URL || "http://localhost:8787/command";

// A Team's Figma resource: in the Team's runs the console sets FIGMA_EXPECTED_FILE_KEY, and then
// every command except checking the connection and which file is open is refused while another
// file is open (the plugin reports the open file's key). Without it, nothing changes.
const EXPECTED_FILE_KEY = process.env.FIGMA_EXPECTED_FILE_KEY || "";
const ANY_FILE = new Set(["PING", "GET_FILE_INFO"]);
async function callBridge(type, params) {
  if (EXPECTED_FILE_KEY && !ANY_FILE.has(type)) {
    const info = await post("GET_FILE_INFO", {});
    if (!info?.fileKey) throw new Error(`Refused: this run may only work on the Team's Figma file (${EXPECTED_FILE_KEY}), and the open file's key can't be read.`);
    if (info.fileKey !== EXPECTED_FILE_KEY) throw new Error(`Refused: the open Figma file is "${info.fileName}" (${info.fileKey}), not the Team's file (${EXPECTED_FILE_KEY}). This run may only work on the Team's file: ask the person to open it in Figma and run the plugin there.`);
  }
  const result = await post(type, params);
  if (!READ_TYPES.has(type)) lastReads.clear(); // the document may have changed: no "unchanged" answers
  return result;
}
async function post(type, params) {
  let res;
  try {
    res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, params: params || {} }),
    });
  } catch (err) {
    throw new Error(`Could not reach the Figma bridge at ${BRIDGE_URL} (is bridge/server.js running?): ${err.message}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }
  return data.result;
}

// Every tool returns its bridge result the same way: JSON text content.
// Keeping this uniform (rather than a bespoke shape per tool) is what
// keeps this layer thin — no per-command result formatting logic lives
// here, that would be duplicating the Executor's own job.
function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
}

function tool(figmaType, inputSchema) {
  const handler = async (args) => toolResult(await callBridge(figmaType, args));
  handler.figmaType = figmaType; // lets figma_batch run the same command
  return handler;
}

// FIGMA_EXECUTOR_LEGACY=1 turns off figma_batch and the compact/deduplicated document reads (the
// behaviour before 2026-10-15), for comparison runs or if they ever misbehave.
const LEGACY = process.env.FIGMA_EXECUTOR_LEGACY === "1";
// Commands that only read the document. Any other command may change it, so after one succeeds the
// "unchanged since your last read" answers below are reset.
const READ_TYPES = new Set(["PING", "GET_FILE_INFO", "LIST_PAGES", "GET_SELECTION", "SEARCH_NODES", "GET_DOCUMENT_STATE", "GET_VARIABLES", "GET_STYLES", "GET_ICON_COMPONENTS", "GET_COMPONENT_TREE", "GET_SCREEN_TREE", "GET_PROTOTYPE", "EXPORT_NODE", "SWITCH_PAGE"]);
const lastReads = new Map(); // document-state request -> { hash, at } of what this run was last given

// --- Reusable schema fragments (match plugin/code.js's real param shapes) --

const Color = z.object({
  r: z.number().min(0).max(1).describe("Red, 0–1"),
  g: z.number().min(0).max(1).describe("Green, 0–1"),
  b: z.number().min(0).max(1).describe("Blue, 0–1"),
  a: z.number().min(0).max(1).optional().describe("Alpha, 0–1, default 1"),
});

const DropShadow = z
  .object({
    color: Color,
    x: z.number().optional(),
    y: z.number().optional(),
    blur: z.number().optional(),
    spread: z.number().optional(),
  })
  .nullable()
  .describe("A drop shadow, or null to clear any existing shadow");

const BoxParams = {
  fill: Color.optional().describe("Solid fill color"),
  cornerRadius: z.number().optional(),
  strokeColor: Color.optional(),
  strokeWeight: z.number().optional().describe("Only applied if strokeColor is set; default 1"),
  dropShadow: DropShadow.optional(),
  opacity: z.number().min(0).max(1).optional(),
};

const TextParams = {
  font: z.object({ family: z.string(), style: z.string() }).optional().describe('e.g. {family:"Inter", style:"Bold"}'),
  fontSize: z.number().optional(),
  fill: Color.optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  letterSpacing: z.union([z.number(), z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) })]).optional(),
  lineHeight: z.union([z.number(), z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) })]).optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  width: z.number().optional().describe("Forces textAutoResize to HEIGHT if it's still WIDTH_AND_HEIGHT, or Figma silently ignores this"),
};

const Padding = z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() });

// --- Server ----------------------------------------------------------------

const server = new McpServer({ name: "figma-executor", version: "0.1.0" });
// Every tool's definition by name, so figma_batch can check each step with that tool's own schema.
const REGISTRY = new Map();
{ const register = server.registerTool.bind(server); server.registerTool = (name, cfg, handler) => { REGISTRY.set(name, { cfg, handler }); return register(name, cfg, handler); }; }

server.registerTool("figma_ping", { description: "Liveness check for the Figma plugin connection." }, tool("PING"));

server.registerTool(
  "figma_get_file_info",
  { description: "File name, editor type, current page, and root id of the connected Figma file. Call this first to confirm which file you're actually connected to." },
  tool("GET_FILE_INFO")
);

server.registerTool("figma_list_pages", { description: "List every page in the file (id + name), without loading their contents." }, tool("LIST_PAGES"));

server.registerTool(
  "figma_create_page",
  { description: "Create a new page.", inputSchema: { name: z.string().optional() } },
  tool("CREATE_PAGE")
);

server.registerTool(
  "figma_rename_page",
  { description: "Rename an existing page.", inputSchema: { id: z.string(), name: z.string() } },
  tool("RENAME_PAGE")
);

server.registerTool(
  "figma_switch_page",
  {
    description:
      "Make a page the current page (figma.setCurrentPageAsync) — the same effect as a human clicking that page's tab. Call this before searching/reading a page you haven't touched yet this session; the first access to a not-yet-loaded page can otherwise fail.",
    inputSchema: { pageId: z.string() },
  },
  tool("SWITCH_PAGE")
);

server.registerTool("figma_get_selection", { description: "What's currently selected in the Figma UI." }, tool("GET_SELECTION"));

server.registerTool(
  "figma_search_nodes",
  {
    description: "Find nodes by name/text substring and/or exact type, scoped to one page (or the current page).",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive substring match against node name or (for TEXT nodes) characters. Omit to match everything."),
      type: z.string().optional().describe('Exact Figma node type, e.g. "COMPONENT", "COMPONENT_SET", "INSTANCE", "TEXT".'),
      pageId: z.string().optional().describe("Defaults to the current page. Use figma_switch_page first if this page hasn't been visited yet."),
      limit: z.number().int().positive().optional().describe("Default 50."),
    },
  },
  tool("SEARCH_NODES")
);

// Inspection that stays small. A node read is compact by default (geometry, auto layout, text
// content and size, fill colours); `fields` adds groups, `detail: "full"` gives the plugin's complete
// dump. Output is bounded by maxChars, and anything cut is said, never silently dropped. A read
// that returns exactly what this run was last given (checked against a fresh read, so manual edits
// in Figma are seen) answers "unchanged" instead of repeating it; any change through these tools
// resets that.
const FIELD_GROUPS = {
  geometry: ["x", "y", "width", "height", "absX", "absY", "visible", "opacity"],
  layout: ["layoutMode", "itemSpacing", "padding", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode", "layoutPositioning", "layoutGrow", "layoutAlign", "clipsContent"],
  text: ["characters", "fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textCase"],
  style: ["fills", "fillStyleId", "strokes", "strokeWeight", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "effects"],
  component: ["key", "remote", "mainComponent", "mainComponentId", "componentProperties", "variantProperties"],
};
const COMPACT = ["geometry", "layout", "text"];
const ALWAYS = ["id", "name", "type"];
function project(node, groups, compact, dropped) {
  const keep = new Set([...ALWAYS, ...groups.flatMap((g) => FIELD_GROUPS[g])]);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "children") continue;
    if (keep.has(k)) out[k] = compact && k === "characters" && typeof v === "string" && v.length > 120 ? v.slice(0, 117) + "…" : v;
    else dropped.add(k);
  }
  // in compact mode a fill is just its colour: enough to tell elements apart, not a style spec
  if (compact && !groups.includes("style") && Array.isArray(node.fills)) { out.fill = node.fills.map((f) => f.hex || f.type).join(" "); dropped.add("fills"); }
  if (Array.isArray(node.children)) out.children = node.children.map((c) => project(c, groups, compact, dropped));
  return out;
}
// Bound the output: summarise children below a depth as counts and ids, deepest first.
function bound(tree, maxChars) {
  const size = (t) => JSON.stringify(t).length;
  if (size(tree) <= maxChars) return { tree, truncated: null };
  const depthOf = (n, d = 0) => (n.children?.length ? Math.max(...n.children.map((c) => depthOf(c, d + 1))) : d);
  const cut = (n, d, at) => (d >= at && n.children ? { ...n, children: undefined, childCount: n.children.length, childIds: n.children.slice(0, 20).map((c) => c.id) } : n.children ? { ...n, children: n.children.map((c) => cut(c, d + 1, at)) } : n);
  for (let at = depthOf(tree) - 1; at >= 0; at--) {
    const t = cut(tree, 0, at);
    if (size(t) <= maxChars) return { tree: t, truncated: { maxChars, keptDepth: at, note: `Children below depth ${at} are summarised as childCount/childIds. Inspect a child by id for its details.` } };
  }
  const t = cut(tree, 0, 0);
  return { tree: t, truncated: { maxChars, keptDepth: 0, note: "Only this node is shown; its children are summarised as childCount/childIds. Inspect them by id." } };
}
const hashOf = (v) => { const s = JSON.stringify(v); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return `${s.length}:${h}`; };

server.registerTool(
  "figma_get_document_state",
  {
    description: LEGACY
      ? "Inspect the document. With no args: shallow list of the current page's top-level children. With pageId: shallow list of that page's children. With id: a full recursive dump of that one node (fills, strokes, layout, text styling, etc.) to the given depth."
      : "Inspect the document. No args: shallow list of the current page's top-level children; pageId: the same for another page. id: that node's subtree, COMPACT by default (id, name, type, geometry, auto layout, text content and size, fill colours). Ask for more with fields (geometry, layout, text, style, component) or detail:\"full\" for every property. Output is bounded by maxChars; anything cut is reported. If nothing changed since your last identical read, it answers unchanged:true instead of repeating it (fresh:true forces the full answer). Don't re-read after each edit: an edit's own result confirms it.",
    inputSchema: {
      id: z.string().optional(),
      depth: z.number().int().nonnegative().optional().describe("Only used with id. Default 4. 0 is accepted but the underlying handler treats it the same as omitting it (falsy fallback), not as 'shallowest'."),
      pageId: z.string().optional(),
      ...(LEGACY ? {} : {
        detail: z.enum(["compact", "full"]).optional().describe("With id: compact (default) or full (every property of every node)."),
        fields: z.array(z.enum(Object.keys(FIELD_GROUPS))).optional().describe("With id: property groups to include instead of the compact set."),
        maxChars: z.number().int().min(2000).max(80000).optional().describe("Output bound, default 15000."),
        fresh: z.boolean().optional().describe("Always return the full answer, even if unchanged since your last read."),
      }),
    },
  },
  LEGACY ? tool("GET_DOCUMENT_STATE") : async ({ id, depth, pageId, detail, fields, maxChars = 15000, fresh }) => {
    const raw = await callBridge("GET_DOCUMENT_STATE", { id, depth, pageId });
    const key = JSON.stringify({ id, depth, pageId, detail, fields, maxChars }), hash = hashOf(raw), seen = lastReads.get(key);
    if (seen && seen.hash === hash && !fresh) return toolResult({ unchanged: true, readAt: seen.at, note: "Identical to what you were given at readAt (checked against a fresh read). Pass fresh:true if you no longer have it." });
    lastReads.set(key, { hash, at: new Date().toISOString() });
    if (!raw.node || detail === "full") { const b = raw.node ? bound(raw.node, maxChars) : { tree: null, truncated: null }; return toolResult(raw.node ? { node: b.tree, ...(b.truncated ? { truncated: b.truncated } : {}) } : raw); }
    const dropped = new Set(), groups = fields?.length ? fields : COMPACT;
    const b = bound(project(raw.node, groups, !fields?.length, dropped), maxChars);
    return toolResult({ node: b.tree, detail: fields?.length ? `fields: ${groups.join(", ")}` : "compact", ...(dropped.size ? { omitted: [...dropped].sort(), omittedNote: "Ask fields:[...] or detail:\"full\" for these." } : {}), ...(b.truncated ? { truncated: b.truncated } : {}) });
  }
);

server.registerTool(
  "figma_get_variables",
  { description: "Every local Variable collection (design tokens): colors, floats, strings, booleans, with cross-collection alias chains resolved to a final value and the immediate alias name." },
  tool("GET_VARIABLES")
);

server.registerTool(
  "figma_get_styles",
  { description: "Local text styles, effect styles (shadows/blurs) and grid styles." },
  tool("GET_STYLES")
);

server.registerTool(
  "figma_get_icon_components",
  {
    description: 'Every COMPONENT on a page whose name starts with a prefix (default "icon/"), with a derived PascalCase name (a pure kebab→Pascal transform — the caller decides whether that name exists in a real icon library, since this plugin sandbox has no network access to check).',
    inputSchema: { pageId: z.string(), prefix: z.string().optional() },
  },
  tool("GET_ICON_COMPONENTS")
);

server.registerTool(
  "figma_get_component_tree",
  {
    description:
      "Read a COMPONENT or COMPONENT_SET as a compact tree: variants, component properties (with INSTANCE_SWAP/VARIANT resolved to names, not raw ids), and each variant's full layout/style/text tree with fills, strokes, radius and spacing resolved to their bound Variable's name wherever tokenized.",
    inputSchema: { id: z.string() },
  },
  tool("GET_COMPONENT_TREE")
);

server.registerTool(
  "figma_get_screen_tree",
  { description: "Read a screen FRAME as the same compact tree figma_get_component_tree produces (name/originalName + tree).", inputSchema: { id: z.string() } },
  tool("GET_SCREEN_TREE")
);

server.registerTool(
  "figma_get_prototype",
  {
    description: "Every prototype reaction (tap → navigate/change-variant/overlay/back/close) on every top-level screen frame of a page, plus the page's flow-start markers.",
    inputSchema: { pageId: z.string() },
  },
  tool("GET_PROTOTYPE")
);

server.registerTool(
  "figma_bind_variable_to_fill",
  {
    description: "Bind an existing fill on a node to a real Figma Variable, replacing whatever literal color was there.",
    inputSchema: { id: z.string(), variableId: z.string(), fillIndex: z.number().int().optional().describe("Default 0 (the first fill).") },
  },
  tool("BIND_VARIABLE_TO_FILL")
);

server.registerTool(
  "figma_import_component_by_key",
  {
    description: "Import a component published to a Team Library by its stable key, and create an instance of it. Throws if the component isn't actually published.",
    inputSchema: { key: z.string(), parentId: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  },
  tool("IMPORT_COMPONENT_BY_KEY")
);

server.registerTool(
  "figma_create_frame",
  {
    description: "Create a FRAME.",
    inputSchema: { parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), insertIndex: z.number().int().optional(), ...BoxParams },
  },
  tool("CREATE_FRAME")
);

server.registerTool(
  "figma_create_component",
  {
    description: "Create a COMPONENT (a master component, not an instance).",
    inputSchema: { parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), insertIndex: z.number().int().optional(), ...BoxParams },
  },
  tool("CREATE_COMPONENT")
);

server.registerTool(
  "figma_create_text",
  {
    description: "Create a TEXT node.",
    inputSchema: {
      parentId: z.string().optional(),
      name: z.string().optional().describe("Figma auto-names text nodes by their content otherwise."),
      content: z.string().optional().describe("Initial characters."),
      x: z.number().optional(),
      y: z.number().optional(),
      insertIndex: z.number().int().optional(),
      fontFamily: z.string().optional(),
      fontStyle: z.string().optional(),
      ...TextParams,
    },
  },
  tool("CREATE_TEXT")
);

server.registerTool(
  "figma_create_vector",
  {
    description:
      'Create a stroked or filled vector icon from raw SVG path data (M/L/C/Z commands only — Figma\'s vectorPaths has no arc "A" command, and needs whitespace around every command letter).',
    inputSchema: {
      parentId: z.string().optional(),
      name: z.string().optional(),
      path: z.string().describe("SVG path data, M/L/C/Z only."),
      windingRule: z.enum(["NONZERO", "EVENODD"]).optional(),
      strokeColor: Color.optional(),
      strokeWeight: z.number().optional().describe("Default 2 if strokeColor is set."),
      strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional(),
      strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
      fillColor: Color.optional().describe("Ignored if strokeColor is set."),
      width: z.number().optional(),
      height: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      insertIndex: z.number().int().optional(),
    },
  },
  tool("CREATE_VECTOR")
);

server.registerTool(
  "figma_create_ellipse",
  {
    description: "Create a true circle/ellipse (exact, unlike approximating one with figma_create_vector).",
    inputSchema: {
      parentId: z.string().optional(),
      name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      strokeColor: Color.optional(),
      strokeWeight: z.number().optional(),
      fillColor: Color.optional().describe("Ignored if strokeColor is set."),
      x: z.number().optional(),
      y: z.number().optional(),
      insertIndex: z.number().int().optional(),
    },
  },
  tool("CREATE_ELLIPSE")
);

server.registerTool(
  "figma_create_instance",
  {
    description: "Create an instance of an existing master COMPONENT. Returns a 2-level shallow tree of the new instance's children, so a nested layer's id (e.g. a Label to override) is available without an extra lookup.",
    inputSchema: { componentId: z.string(), parentId: z.string().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  },
  tool("CREATE_INSTANCE")
);

server.registerTool(
  "figma_combine_as_variants",
  {
    description: 'Merge several single-variant COMPONENTs into one COMPONENT_SET. Each source component\'s name must already be in Figma\'s "Prop=Value" convention — that\'s the only way Figma derives the variant property name.',
    inputSchema: { componentIds: z.array(z.string()).min(2), parentId: z.string().optional(), name: z.string().optional() },
  },
  tool("COMBINE_AS_VARIANTS")
);

server.registerTool(
  "figma_set_auto_layout",
  {
    description: "Enable/configure auto layout on an existing frame-like node.",
    inputSchema: {
      id: z.string(),
      layoutMode: z.enum(["HORIZONTAL", "VERTICAL", "NONE"]).optional().describe("Default VERTICAL."),
      itemSpacing: z.number().optional(),
      padding: Padding.optional(),
      paddingAll: z.number().optional().describe("Sets all 4 sides at once; padding (if also given) overrides individual sides after this."),
      primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
      counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
      primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
      counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
      layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("WRAP only takes effect with primaryAxisSizingMode FIXED and an explicit width."),
    },
  },
  tool("SET_AUTO_LAYOUT")
);

server.registerTool(
  "figma_modify_node",
  {
    description:
      "Change properties of an existing node. Only the props you include are touched. layoutPositioning must be set in the SAME call as x/y if you want a flow-managed node to become absolutely positioned at that x/y — Figma discards manual x/y on a still-flow-managed node otherwise.",
    inputSchema: {
      id: z.string(),
      props: z
        .object({
          parentId: z.string().optional().describe("Reparents the node."),
          insertIndex: z.number().int().optional().describe("Only used with parentId, to control position among the new parent's children."),
          layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
          name: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          visible: z.boolean().optional(),
          layoutGrow: z.number().optional(),
          layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
          layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
          characters: z.string().optional().describe("TEXT nodes only."),
          fills: z
            .array(z.record(z.string(), z.any()))
            .optional()
            .describe(
              "Raw Figma Paint array (gradients, multiple layers, IMAGE paints) for when `fill` (single solid colour) isn't enough. Replaces every existing fill. Each entry is a Figma Paint object as the plugin API expects it, e.g. {type:\"GRADIENT_LINEAR\", gradientStops:[...], gradientTransform:[...]} or {type:\"IMAGE\", scaleMode, imageHash}. There's no tool to create a fresh imageHash — to reuse a photo already in the file, use copyFillsFrom instead."
            ),
          copyFillsFrom: z
            .string()
            .optional()
            .describe("Id of another node to copy fills from (e.g. to reuse an existing photo's IMAGE paint, whose imageHash isn't otherwise reachable). The source node is only read, never modified. Any IMAGE paint copied this way is set to scaleMode FILL."),
          ...BoxParams,
          ...TextParams,
        })
        .passthrough(),
    },
  },
  tool("MODIFY_NODE")
);

server.registerTool(
  "figma_detach_instance",
  { description: "Break an instance's link to its master component, turning it into a plain editable frame (needed before adding/removing its children — instances forbid that while linked).", inputSchema: { id: z.string() } },
  tool("DETACH_INSTANCE")
);

server.registerTool(
  "figma_set_instance_properties",
  {
    description:
      "Set an INSTANCE's component properties: text (string), boolean show/hide toggles (true/false), instance-swap (value = a COMPONENT id, e.g. to change an icon) and variant (value = option name, e.g. \"false\"). Names may omit Figma's \"#123:4\" suffix; an unknown name fails with the list of available ones. Returns every property's value after the change.",
    inputSchema: {
      id: z.string(),
      properties: z.record(z.string(), z.union([z.string(), z.boolean()])),
    },
  },
  tool("SET_INSTANCE_PROPERTIES")
);

server.registerTool("figma_delete_node", { description: "Delete a node.", inputSchema: { id: z.string() } }, tool("DELETE_NODE"));

server.registerTool(
  "figma_export_node",
  {
    description: "Render a node to an image/vector file. Returns a local file path (not the raw bytes) — read that file to see the result.",
    inputSchema: {
      id: z.string(),
      format: z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Default PNG."),
      scale: z.number().positive().optional().describe("PNG/JPG only. Default 2."),
    },
  },
  tool("EXPORT_NODE")
);

// --- Batches ------------------------------------------------------------------
// One call runs many edits, in order, through the same commands and checks as the single tools (each
// step is validated against its own tool's schema; the Figma file lock applies to every step). A
// step may name its new node (ref) and later steps use "$ref" wherever an id goes. Only the edit
// tools below can be batched: no reads, exports or page switches, and no code of any kind.
const BATCHABLE = ["figma_create_frame", "figma_create_component", "figma_create_text", "figma_create_vector", "figma_create_ellipse", "figma_create_instance", "figma_combine_as_variants",
  "figma_set_auto_layout", "figma_modify_node", "figma_delete_node", "figma_detach_instance", "figma_set_instance_properties", "figma_bind_variable_to_fill", "figma_import_component_by_key", "figma_import_image", "figma_rename_page"].filter((t) => REGISTRY.has(t)); // only tools this server registers
const MAX_OPS = 100, MAX_BATCH_CHARS = 200000, REF = /^\$([A-Za-z_][\w-]{0,40})$/;
const mapStrings = (v, fn) => (typeof v === "string" ? fn(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, fn)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) : v);
const refsIn = (v) => { const out = []; mapStrings(v, (s) => { const m = REF.exec(s); if (m) out.push(m[1]); return s; }); return out; };
if (!LEGACY) server.registerTool(
  "figma_batch",
  {
    description: `Run many Figma edits in ONE call (up to ${MAX_OPS}), in order: create a whole section, then style and lay it out, instead of one tool call per element. Each op is {tool, args, ref?}: tool is one of ${BATCHABLE.map((t) => t.replace("figma_", "")).join(", ")} (with or without the figma_ prefix); args are that tool's own arguments; ref names the node the op creates, and later ops write "$ref" wherever they need its id (parentId, id, ...). Every op is validated before anything runs; an invalid batch changes nothing. If an op fails, ops that use its ref are skipped and the rest continue (stopOnError:true stops instead). Returns a compact report: per op ok/failed/skipped, the created ids by ref, and the errors. The report confirms what Figma did; it is not visual verification: export the finished section (figma_export_node) and look at it. Don't re-read the document after a batch just to confirm it.`,
    inputSchema: {
      ops: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional(), ref: z.string().regex(/^[A-Za-z_][\w-]{0,40}$/).optional() })).min(1).max(MAX_OPS),
      stopOnError: z.boolean().optional(),
    },
  },
  async ({ ops, stopOnError = false }) => {
    const started = Date.now();
    if (JSON.stringify(ops).length > MAX_BATCH_CHARS) return { isError: true, content: [{ type: "text", text: `Refused: the batch is larger than ${MAX_BATCH_CHARS} characters. Split it into smaller batches.` }] };
    // Validate everything first: tools, arguments (against each tool's schema), refs.
    const problems = [], defined = new Set(), plan = [];
    ops.forEach((op, i) => {
      const name = op.tool.startsWith("figma_") ? op.tool : `figma_${op.tool}`, reg = REGISTRY.get(name), args = op.args || {};
      if (!BATCHABLE.includes(name) || !reg?.handler?.figmaType) { problems.push({ i, error: `"${op.tool}" can't be batched. Batchable: ${BATCHABLE.map((t) => t.replace("figma_", "")).join(", ")}.` }); return; }
      for (const r of refsIn(args)) if (!defined.has(r)) problems.push({ i, error: `$${r} is used before an earlier op defines ref "${r}".` });
      const check = z.object(reg.cfg.inputSchema || {}).safeParse(mapStrings(args, (s) => (REF.test(s) ? "0:0" : s)));
      if (!check.success) problems.push({ i, error: `${name} arguments: ${check.error.issues.map((x) => `${x.path.join(".") || "(args)"} ${x.message}`).join("; ")}` });
      if (op.ref) { if (defined.has(op.ref)) problems.push({ i, error: `ref "${op.ref}" is defined twice.` }); defined.add(op.ref); }
      plan.push({ i, name, type: reg.handler.figmaType, args, ref: op.ref });
    });
    if (problems.length) return { isError: true, content: [{ type: "text", text: JSON.stringify({ refused: "Nothing was run: fix these ops and send the batch again.", problems }, null, 1) }] };
    // Run in order; a failed op's dependants are skipped.
    const created = {}, failedRefs = new Set(), results = [];
    let stopped = null;
    for (const p of plan) {
      const needs = refsIn(p.args), brokenDep = needs.find((r) => failedRefs.has(r));
      if (stopped !== null || brokenDep) {
        results.push({ i: p.i, tool: p.name.replace("figma_", ""), ...(p.ref ? { ref: p.ref } : {}), status: "skipped", reason: stopped !== null ? `stopped after op ${stopped} failed` : `depends on $${brokenDep}, which failed` });
        if (p.ref) failedRefs.add(p.ref);
        continue;
      }
      try {
        const r = await callBridge(p.type, mapStrings(p.args, (s) => { const m = REF.exec(s); return m ? created[m[1]] : s; }));
        const id = r?.id ?? r?.node?.id ?? null;
        if (p.ref) { if (id) created[p.ref] = id; else failedRefs.add(p.ref); }
        results.push({ i: p.i, tool: p.name.replace("figma_", ""), ...(p.ref ? { ref: p.ref } : {}), status: "ok", ...(id ? { id } : {}), ...(r?.summary ? { summary: String(r.summary).replace(/^SUCCESS:\s*/, "").slice(0, 100) } : {}) });
      } catch (e) {
        if (p.ref) failedRefs.add(p.ref);
        results.push({ i: p.i, tool: p.name.replace("figma_", ""), ...(p.ref ? { ref: p.ref } : {}), status: "failed", error: String(e.message || e).slice(0, 300) });
        if (stopOnError) stopped = p.i;
      }
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    const report = { ops: results.length, ok: count("ok"), failed: count("failed"), skipped: count("skipped"), created, ms: Date.now() - started,
      results, verification: "Not visually verified: these are Figma's confirmations of each edit. Export the section and look at it to verify." };
    return { ...(report.failed ? { isError: false } : {}), content: [{ type: "text", text: JSON.stringify(report, null, 1) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
