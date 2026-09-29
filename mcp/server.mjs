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

async function callBridge(type, params) {
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
  return async (args) => toolResult(await callBridge(figmaType, args));
}

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

server.registerTool(
  "figma_get_document_state",
  {
    description:
      "Inspect the document. With no args: shallow list of the current page's top-level children. With pageId: shallow list of that page's children. With id: a full recursive dump of that one node (fills, strokes, layout, text styling, etc.) to the given depth.",
    inputSchema: {
      id: z.string().optional(),
      depth: z.number().int().positive().optional().describe("Only used with id. Default 4."),
      pageId: z.string().optional(),
    },
  },
  tool("GET_DOCUMENT_STATE")
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

const transport = new StdioServerTransport();
await server.connect(transport);
