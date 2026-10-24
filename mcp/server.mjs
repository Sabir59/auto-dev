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

import { ensureBridge, bridgeStatus, waitForPlugin, BRIDGE_PROTOCOL } from "../bridge/launcher.mjs";
import { parseFigmaUrl } from "../figma-reader/reader.mjs";

const BRIDGE_URL = process.env.FIGMA_BRIDGE_URL || `http://localhost:${Number(process.env.FIGMA_BRIDGE_PORT) || 8787}/command`;
const BRIDGE_BASE = new URL("/", BRIDGE_URL).origin;
// The bridge starts itself: the first call that finds nothing listening starts bridge/server.js
// (bridge/launcher.mjs). On for the default local bridge; FIGMA_BRIDGE_AUTOSTART=0 turns it off, =1
// turns it on for a FIGMA_BRIDGE_URL that's set explicitly.
const AUTOSTART = process.env.FIGMA_BRIDGE_AUTOSTART === "1" || (process.env.FIGMA_BRIDGE_AUTOSTART !== "0" && !process.env.FIGMA_BRIDGE_URL);
// How long a call waits for a plugin that's on its way back (a bridge that just started, or a
// plugin that just dropped: plugin/ui.html reconnects within a few seconds).
const PLUGIN_WAIT_MS = Number(process.env.FIGMA_PLUGIN_WAIT_MS) || 12000;

// FIGMA_EXECUTOR_PROFILE=read: the server itself is read-only. Only the read tools are registered,
// and any command that could change the document is refused below the tool layer too. The console
// sets it for every run that may only read Figma, whatever its allow list says.
const READ_ONLY = process.env.FIGMA_EXECUTOR_PROFILE === "read";
// Commands a read-only run may send: they read the document and change neither it nor what the
// person sees (no page switching) nor anything on disk (no exports).
const READ_ONLY_TYPES = new Set(["PING", "GET_FILE_INFO", "LIST_PAGES", "GET_SELECTION", "SEARCH_NODES", "GET_DOCUMENT_STATE", "GET_VARIABLES", "GET_STYLES", "GET_ICON_COMPONENTS", "GET_COMPONENT_TREE", "GET_SCREEN_TREE", "GET_PROTOTYPE"]);

// A Team's Figma resource: in the Team's runs the console sets FIGMA_EXPECTED_FILE_KEY, and then
// every command except checking the connection and which file is open is refused while another
// file is open (the plugin reports the open file's key). Without it, a run can still pin itself to
// one file with figma_use_file; with it, only to that file. The bridge routes every command to the
// pinned file's plugin and refuses when it isn't open; the GET_FILE_INFO check stays as well (it's
// what protects against an older bridge that doesn't route).
const EXPECTED_FILE_KEY = process.env.FIGMA_EXPECTED_FILE_KEY || "";
let pinnedFile = null; // { fileKey, url? } from figma_use_file
const targetKey = () => EXPECTED_FILE_KEY || pinnedFile?.fileKey || "";
const ANY_FILE = new Set(["PING", "GET_FILE_INFO"]);

// Every failure has a code (the first word of the message, and in figma_executor_status), so the
// worker can tell what's wrong and who can fix it:
//   BRIDGE_UNAVAILABLE, BRIDGE_START_FAILED, MISSING_DEPENDENCY, PORT_IN_USE: the local bridge;
//   PLUGIN_NOT_CONNECTED, FILE_NOT_OPEN, AMBIGUOUS_SESSION: the person has to run the plugin
//     (in the right file) — Figma only runs a plugin when a person runs it;
//   WRONG_FILE, READ_ONLY: refused by this run's scope; COMMAND_FAILED: Figma refused the edit;
//   TIMEOUT, PLUGIN_DISCONNECTED: the outcome is unknown, check before retrying.
const USER_RUNS_PLUGIN = "The person has to open the file in the Figma desktop app and run Plugins → Development → AI Executor (POC); Figma has no API that starts a plugin from outside the editor. Once it's running, the bridge connects by itself.";
const NEXT = {
  PLUGIN_NOT_CONNECTED: USER_RUNS_PLUGIN,
  FILE_NOT_OPEN: USER_RUNS_PLUGIN,
  AMBIGUOUS_SESSION: "Call figma_use_file with the file's link or key, so commands go to that file.",
  WRONG_FILE: "Work only on this run's file; ask the person to open it and run the plugin there.",
  READ_ONLY: "This run may only read Figma. Report what should change instead.",
  TIMEOUT: "Check the node (figma_verify_nodes or figma_get_document_state) before sending the command again.",
  PLUGIN_DISCONNECTED: "Check the node once the plugin is back (figma_executor_status), before sending the command again.",
};
function failure(code, message, { nextStep = NEXT[code] || "" } = {}) {
  return Object.assign(new Error(`${code}: ${message}${nextStep ? ` ${nextStep}` : ""}`), { code, nextStep });
}

async function callBridge(type, params) {
  if (READ_ONLY && !READ_ONLY_TYPES.has(type)) throw failure("READ_ONLY", `Refused: this run may only read Figma, and ${type} isn't a read.`);
  const key = targetKey();
  if (key && !ANY_FILE.has(type)) {
    const team = !!EXPECTED_FILE_KEY, whose = team ? "the Team's" : "this run's";
    const info = await post("GET_FILE_INFO", {});
    if (!info?.fileKey) throw failure("WRONG_FILE", `Refused: this run may only work on ${whose} Figma file (${key}), and the open file's key can't be read.`);
    if (info.fileKey !== key) throw failure("WRONG_FILE", `Refused: the open Figma file is "${info.fileName}" (${info.fileKey}), not ${whose} file (${key}). This run may only work on ${team ? "the Team's file: ask the person to open it in Figma and run the plugin there" : "the file figma_use_file chose"}.`);
  }
  const result = await post(type, params);
  if (!READ_TYPES.has(type)) lastReads.clear(); // the document may have changed: no "unchanged" answers
  return result;
}

// One command to the bridge. A bridge that isn't running is started; a plugin that's on its way
// back is waited for. Nothing is ever retried once the plugin may have received it.
async function post(type, params) {
  const body = JSON.stringify({ type, params: params || {}, ...(targetKey() ? { fileKey: targetKey() } : {}) });
  const send = () => fetch(BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  let res;
  try {
    res = await send();
  } catch (err) {
    if (!AUTOSTART) throw failure("BRIDGE_UNAVAILABLE", `Could not reach the Figma bridge at ${BRIDGE_URL}: ${err.cause?.code || err.message}.`, { nextStep: "Start it: node bridge/server.js, or the dashboard's Figma Bridge switch." });
    const up = await ensureBridge(BRIDGE_BASE);
    if (!up.ok) throw failure(up.code, up.error, { nextStep: up.nextStep });
    await waitForPlugin(BRIDGE_BASE, { fileKey: targetKey() || null, timeout: PLUGIN_WAIT_MS });
    try { res = await send(); } catch (e) { throw failure("BRIDGE_UNAVAILABLE", `The Figma bridge started but can't be reached: ${e.message}.`); }
  }
  let data = await readReply(res);
  // Nothing reached a plugin, so it's safe to wait for one that's on its way back and send again.
  if (!data.ok && ["PLUGIN_NOT_CONNECTED", "FILE_NOT_OPEN"].includes(data.code) && (await reconnecting())) {
    await waitForPlugin(BRIDGE_BASE, { fileKey: targetKey() || null, timeout: PLUGIN_WAIT_MS });
    data = await readReply(await send());
  }
  if (!data.ok) {
    const msg = data.code === "PLUGIN_NOT_CONNECTED" ? "No Figma plugin is connected to the bridge." : typeof data.error === "string" ? data.error : JSON.stringify(data.error);
    const open = data.openFiles?.length ? ` Open with the plugin running: ${data.openFiles.map((f) => `"${f.fileName}" (${f.fileKey || "key unknown"})`).join(", ")}.` : "";
    throw failure(data.code, msg + open);
  }
  return data.result;
}
// An older bridge (protocol 1) has no codes: its 503 is "no plugin", 504 a timeout.
async function readReply(res) {
  let data; try { data = await res.json(); } catch { data = { ok: false, code: "BRIDGE_UNAVAILABLE", error: `The bridge answered HTTP ${res.status} with no JSON.` }; }
  if (!data.ok && !data.code) data.code = res.status === 503 ? "PLUGIN_NOT_CONNECTED" : res.status === 504 ? "TIMEOUT" : res.status === 403 ? "REFUSED" : "COMMAND_FAILED";
  return data;
}
// Whether a plugin is likely to come back by itself soon: the bridge just started, or a plugin
// just dropped (Figma tearing down the plugin's iframe, a bridge restart).
async function reconnecting() {
  const s = await bridgeStatus(BRIDGE_BASE);
  if (!s.isBridge || !s.status.startedAt) return false;
  const since = Math.max(Date.parse(s.status.startedAt), s.status.lastDisconnect ? Date.parse(s.status.lastDisconnect.at) : 0);
  return Date.now() - since < 30000;
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
const READ_TYPES = new Set(["PING", "GET_FILE_INFO", "LIST_PAGES", "GET_SELECTION", "SELECT_NODES", "SEARCH_NODES", "GET_DOCUMENT_STATE", "GET_VARIABLES", "GET_STYLES", "GET_ICON_COMPONENTS", "GET_COMPONENT_TREE", "GET_SCREEN_TREE", "GET_PROTOTYPE", "EXPORT_NODE", "SWITCH_PAGE"]);
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
  dashPattern: z.array(z.number()).optional().describe("e.g. [4,4] for a dashed stroke. Only visible once strokeColor is also set (same call or a prior one)."),
  dropShadow: DropShadow.optional(),
  opacity: z.number().min(0).max(1).optional(),
  clipsContent: z.boolean().optional().describe("Whether this frame/component clips children that overflow its bounds (e.g. an absolutely-positioned decorative child bleeding past a rounded corner)."),
};

// Word-level styling inside one text node (plugin/code.js applyTextRanges): applied after the
// whole-node properties, so ranges override them.
const Spacing = z.union([z.number(), z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) })]);
const TextRange = z
  .object({
    start: z.number().int().min(0).optional().describe("Start index (JS string index, same as Figma's)."),
    end: z.number().int().min(1).optional().describe("End index, exclusive."),
    match: z.string().min(1).optional().describe("Style this exact text instead of start/end. If it isn't found, the error quotes the node's text."),
    occurrence: z.union([z.literal("all"), z.number().int().min(1)]).optional().describe('With match: "all" (default) or which occurrence, counting from 1.'),
    fill: Color.optional(),
    fillVariableId: z.string().optional().describe("Bind this range's colour to a COLOR variable (a token) instead of a literal fill."),
    fillVariable: z.string().optional().describe("Same as fillVariableId, but the variable's name (e.g. \"muted-foreground\")."),
    textStyle: z.string().optional().describe("Apply a local text style (name or id, e.g. \"body/sm\") to this range."),
    font: z.object({ family: z.string().optional(), style: z.string().optional() }).optional().describe('e.g. {family:"Amiri", style:"Regular"} for a glyph the main font lacks (ﷺ). Loaded automatically.'),
    fontSize: z.number().optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    letterSpacing: Spacing.optional(),
    lineHeight: Spacing.optional(),
  })
  .refine((r) => r.match !== undefined || (r.start !== undefined && r.end !== undefined), { message: "each range needs match, or both start and end" });
const RANGES_HELP = 'Word-level styling, applied after the whole-node styles so it overrides them; works on text inside instances (as overrides) and in figma_batch. Example: ranges:[{match:"MEN ONLY", fill:{r:0.969,g:0.576,b:0.118}}] or [{start:0,end:8,font:{family:"Jost",style:"Bold"}}]. The result lists the styled segments (start, end, text, fill hex, font) so you can check without exporting.';

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
  ranges: z.array(TextRange).max(200).optional().describe(RANGES_HELP),
};

const Padding = z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() });

// --- Server ----------------------------------------------------------------

const server = new McpServer({ name: "figma-executor", version: "0.1.0" });
// Every tool's definition by name, so figma_batch can check each step with that tool's own schema.
const REGISTRY = new Map();
// Read-only, a tool that isn't a read is never registered: the worker can't even see it.
const READ_TOOLS = new Set([...["ping", "get_file_info", "list_pages", "get_selection", "search_nodes", "get_document_state", "get_variables", "get_styles", "get_icon_components", "get_component_tree", "get_screen_tree", "get_prototype"].map((t) => `figma_${t}`),
  "figma_executor_status", "figma_use_file", "figma_verify_nodes"]);
{ const register = server.registerTool.bind(server); server.registerTool = (name, cfg, handler) => { if (READ_ONLY && !READ_TOOLS.has(name)) return null; REGISTRY.set(name, { cfg, handler }); return register(name, cfg, handler); }; }

server.registerTool("figma_ping", { description: "Liveness check for the Figma plugin connection." }, tool("PING"));

server.registerTool(
  "figma_get_file_info",
  { description: "File name, editor type, current page, and root id of the connected Figma file. Call this first to confirm which file you're actually connected to." },
  tool("GET_FILE_INFO")
);

// ---- Availability, which file, and verification -------------------------------------------
// Machine-readable: what works now, what doesn't, and whether only the person can fix it. Starts
// the bridge if it isn't running (so a plugin that's already open can connect). Never shows a
// credential: the Executor path has none (the plugin acts as the person who ran it).
async function executorStatus() {
  const key = targetKey();
  const out = { profile: READ_ONLY ? "read" : "edit", fileScope: EXPECTED_FILE_KEY ? { fileKey: EXPECTED_FILE_KEY, source: "team" } : pinnedFile ? { ...pinnedFile, source: "figma_use_file" } : null,
    bridge: { url: BRIDGE_BASE, autostart: AUTOSTART } };
  const verdict = (state, ready, userActionRequired, message, nextStep = NEXT[state] || "") => ({ state, ready, canEdit: ready && !READ_ONLY, userActionRequired, message, ...(nextStep ? { nextStep } : {}), ...out });
  if (AUTOSTART) {
    const up = await ensureBridge(BRIDGE_BASE);
    if (!up.ok) return verdict(up.code, false, up.code !== "BRIDGE_START_FAILED", up.error, up.nextStep);
    out.bridge.started = up.started; out.bridge.restarted = up.restarted;
  }
  let s = await bridgeStatus(BRIDGE_BASE);
  if (!s.isBridge) return verdict("BRIDGE_UNAVAILABLE", false, true, s.reachable ? `Something else answers at ${BRIDGE_BASE}: ${s.error}.` : `No bridge at ${BRIDGE_BASE} (${s.error}).`, "Start it: node bridge/server.js, or the dashboard's Figma Bridge switch.");
  if (!s.status.pluginConnected || (key && s.status.sessions && !s.status.sessions.some((x) => x.fileKey === key))) s = (await reconnecting()) || out.bridge.started ? await waitForPlugin(BRIDGE_BASE, { fileKey: key || null, timeout: 6000 }) : s;
  const st = s.status || {};
  Object.assign(out.bridge, { running: true, protocol: st.protocol || 1, pid: st.pid ?? null, startedAt: st.startedAt ?? null, ...(s.outdated ? { outdated: true, note: `An older bridge is running (protocol ${st.protocol || 1}, current ${BRIDGE_PROTOCOL}). It's kept while a plugin is connected; restart it (the dashboard's switch) to update it.` } : {}) });
  const sessions = st.sessions || (st.pluginConnected ? [{ fileName: null, fileKey: null, note: "an older bridge doesn't report files" }] : []);
  out.plugin = { connected: !!st.pluginConnected, sessions, lastDisconnect: st.lastDisconnect ?? null };
  if (!sessions.length) return verdict("PLUGIN_NOT_CONNECTED", false, true, "The bridge is running, but no Figma plugin is connected.");
  if (key) {
    if (!st.sessions || sessions.some((x) => x.fileKey === key)) return verdict("READY", true, false, `The plugin is running in this run's file (${key}).`, "");
    return verdict("FILE_NOT_OPEN", false, true, `The plugin is running, but not in this run's file (${key}). Open: ${sessions.map((x) => `"${x.fileName}" (${x.fileKey || "key unknown"})`).join(", ")}.`);
  }
  if (new Set(sessions.map((x) => x.fileKey || x.session)).size > 1) return verdict("AMBIGUOUS_SESSION", false, false, `The plugin is running in ${sessions.length} files.`);
  return verdict("READY", true, false, `The plugin is running in "${sessions[0].fileName ?? "the open file"}".`, "");
}

server.registerTool(
  "figma_executor_status",
  { description: "Whether Figma work can start now, machine-readable: state (READY, PLUGIN_NOT_CONNECTED, FILE_NOT_OPEN, AMBIGUOUS_SESSION, BRIDGE_UNAVAILABLE, BRIDGE_START_FAILED, MISSING_DEPENDENCY, PORT_IN_USE), whether only the person can fix it (userActionRequired) and the next step; the files that have the plugin running; this run's profile (read or edit) and file scope. Starts the local bridge if it isn't running. Call it first, and whenever a Figma call fails with one of these codes." },
  async () => toolResult(await executorStatus())
);

server.registerTool(
  "figma_use_file",
  {
    description: "Point this run's Figma tools at one file, by its link or key: every command then goes to the plugin running in that file, and is refused while it isn't. Use it when you're given a Figma link, or when several files have the plugin running (AMBIGUOUS_SESSION). In a Team run, only the Team's file is allowed. It doesn't open the file or start the plugin (Figma doesn't allow that from outside): it returns the status, which says what the person has to do.",
    inputSchema: { url: z.string().optional().describe("A figma.com design link."), fileKey: z.string().regex(/^[A-Za-z0-9]{10,}$/).optional().describe("The file key, if you have no link.") },
  },
  async ({ url, fileKey }) => {
    let ref = null;
    if (url) { try { ref = parseFigmaUrl(url); } catch (e) { throw failure("BAD_REQUEST", e.message); } }
    const key = ref?.fileKey || fileKey;
    if (!key) throw failure("BAD_REQUEST", "Give the file's link (url) or its key (fileKey).");
    if (EXPECTED_FILE_KEY && key !== EXPECTED_FILE_KEY) throw failure("WRONG_FILE", `Refused: this run may only work on the Team's Figma file (${EXPECTED_FILE_KEY}), not ${key}.`);
    pinnedFile = { fileKey: key, ...(url ? { url: String(url).slice(0, 500) } : {}) };
    lastReads.clear();
    return toolResult({ ...(ref?.nodeId ? { nodeId: ref.nodeId } : {}), ...(await executorStatus()) });
  }
);

// After an edit: read each node back from Figma, fresh, and compare it with what was meant. This is
// proof that the document holds the change (not just that a command returned), not a visual check.
const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 0.5;
server.registerTool(
  "figma_verify_nodes",
  {
    description: "Verify edits by reading the nodes back from Figma now: each id exists, and has the expected values (name, type, characters, visible, x, y, width, height within 0.5px, fill as #rrggbb, the first visible fill). Returns verified:true only if every check passed, with each mismatch (expected vs actual). It proves the document holds the change; export and look for visual quality.",
    inputSchema: {
      checks: z.array(z.object({
        id: z.string(),
        expect: z.object({ name: z.string(), type: z.string(), characters: z.string(), visible: z.boolean(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), fill: z.string().regex(/^#?[0-9a-fA-F]{6}$/) }).partial().optional(),
      })).min(1).max(50),
    },
  },
  async ({ checks }) => toolResult(await verifyNodes(checks))
);
async function verifyNodes(checks) {
  const results = [];
  for (const { id, expect = {} } of checks) {
    let n;
    try { n = (await callBridge("GET_DOCUMENT_STATE", { id, depth: 1 })).node; }
    catch (e) { results.push({ id, ok: false, exists: /not found/i.test(e.message) ? false : null, error: String(e.message).slice(0, 300) }); continue; }
    const actual = (k) => (k === "fill" ? n.fills?.[0]?.hex ?? null : k === "visible" ? n.visible !== false : n[k] ?? null);
    const mismatches = Object.entries(expect).filter(([k, v]) => {
      const a = actual(k);
      return k === "fill" ? String(a).toLowerCase() !== `#${String(v).replace(/^#/, "").toLowerCase()}` : typeof v === "number" ? !near(a, v) : a !== v;
    }).map(([k, v]) => ({ field: k, expected: v, actual: actual(k) }));
    results.push({ id, ok: !mismatches.length, exists: true, name: n.name, type: n.type, ...(mismatches.length ? { mismatches } : {}) });
  }
  return { verified: results.every((r) => r.ok), checked: results.length, failed: results.filter((r) => !r.ok).length, results, method: "Read back from Figma after the edit. Not a visual check." };
}

server.registerTool("figma_list_pages",{ description: "List every page in the file (id + name), without loading their contents." }, tool("LIST_PAGES"));

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
  text: ["characters", "fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textCase", "segments"],
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
  "figma_set_reactions",
  {
    description: "Write prototype links in bulk: each item makes a node (a button, a tab, an instance sublayer I<inst>;<child>) navigate to a destination frame, go BACK, or (nav:\"change\") swap to a sibling variant. on: click (default), hover, press, drag, or after (a timed move after `delay` ms, e.g. a progress screen that advances by itself). Replaces each node's reactions unless append:true. flows sets the current page's flow starting points. Read them back with figma_get_prototype.",
    inputSchema: {
      items: z.array(z.object({
        id: z.string(), to: z.string().describe('Destination frame id, or "BACK"'),
        on: z.enum(["click", "hover", "press", "drag", "after"]).optional(), delay: z.number().min(10).max(60000).optional().describe("ms, with on:\"after\""),
        transition: z.enum(["instant", "dissolve", "smart", "push-left", "push-right", "slide-up", "slide-down"]).optional(),
        nav: z.enum(["change"]).optional(), keepScroll: z.boolean().optional(),
      })).min(1).max(500),
      append: z.boolean().optional(),
      flows: z.array(z.object({ nodeId: z.string(), name: z.string() })).optional(),
    },
  },
  tool("SET_REACTIONS")
);

server.registerTool(
  "figma_clone_node",
  {
    description: "Duplicate a node (instances stay instances, overrides kept) into parentId at insertIndex: e.g. a screen copied to make a variant of it.",
    inputSchema: { id: z.string(), parentId: z.string().optional(), insertIndex: z.number().int().optional(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  },
  tool("CLONE_NODE")
);

server.registerTool(
  "figma_select_nodes",
  {
    description: "Select nodes on their page (switching to it) and zoom the editor to them, e.g. to show the person the frame a prototype starts from. Changes the selection and viewport only, not the document.",
    inputSchema: { ids: z.array(z.string()).min(1).max(200), zoom: z.boolean().optional().describe("Default true") },
  },
  tool("SELECT_NODES")
);

server.registerTool(
  "figma_create_variable_collection",
  {
    description: "Create a local variable collection (or find the one with that name) with named modes, e.g. {name:\"Color\", modes:[\"Dark\"]}. Returns its id and modeIds for figma_create_variable.",
    inputSchema: { name: z.string(), modes: z.array(z.string()).max(20).optional() },
  },
  tool("CREATE_VARIABLE_COLLECTION")
);

server.registerTool(
  "figma_bind_variable_to_fill",
  {
    description: "Bind an existing fill on a node to a real Figma Variable, replacing whatever literal color was there.",
    inputSchema: { id: z.string(), variableId: z.string(), fillIndex: z.number().int().optional().describe("Default 0 (the first fill).") },
  },
  tool("BIND_VARIABLE_TO_FILL")
);

const VariableValue = z.union([
  Color,
  z.number(),
  z.string(),
  z.boolean(),
  z.object({ aliasOf: z.string().describe("Another variable's id — makes this mode's value an alias instead of a literal") }),
]);

server.registerTool(
  "figma_create_variable",
  {
    description:
      "Create a new Variable (design token) in an existing collection. Optionally set its value per mode in the same call via valuesByMode (literal, or {aliasOf: variableId} to alias another variable) — same effect as figma_set_variable_value per mode, just in one round trip.",
    inputSchema: {
      collectionId: z.string(),
      name: z.string(),
      type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
      description: z.string().optional(),
      codeSyntaxWeb: z.string().optional().describe('e.g. "var(--book-band)"'),
      valuesByMode: z.record(z.string(), VariableValue).optional().describe("Keyed by mode NAME or modeId. COLOR values use {r,g,b,a} 0–1."),
    },
  },
  tool("CREATE_VARIABLE")
);

server.registerTool(
  "figma_set_variable_value",
  {
    description: "Set an existing Variable's value for one mode — a literal, or an alias to another variable (params.aliasOf).",
    inputSchema: {
      variableId: z.string(),
      mode: z.string().optional().describe("Mode name or modeId. Defaults to the collection's default mode."),
      value: VariableValue.optional().describe("Literal value — omit if using aliasOf."),
      aliasOf: z.string().optional().describe("Another variable's id — sets this mode's value to alias it instead of a literal."),
    },
  },
  tool("SET_VARIABLE_VALUE")
);

server.registerTool(
  "figma_create_text_style",
  {
    description: "Create a local text style, or update the one with the same name.",
    inputSchema: {
      name: z.string().describe('e.g. "headline/xs"'),
      family: z.string(),
      style: z.string().optional().describe('Font style, e.g. "Medium". Default "Regular".'),
      fontSize: z.number(),
      lineHeight: z.union([z.number(), z.string()]).optional().describe('px number, "120%", or "AUTO".'),
      letterSpacing: z.union([z.number(), z.string()]).optional().describe('px number or "1%".'),
      textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
      description: z.string().optional(),
      fontVariable: z.string().optional().describe('Bind the font family to a STRING variable, e.g. "font/arabic".'),
    },
  },
  tool("CREATE_TEXT_STYLE")
);

server.registerTool(
  "figma_add_variable_mode",
  {
    description:
      'Add a new mode (e.g. "Dark") to an existing Variable collection. Figma gives every existing variable in the collection a copy of the default mode\'s value as a starting point — follow up with figma_set_variable_value per variable to actually diverge it.',
    inputSchema: { collectionId: z.string(), name: z.string() },
  },
  tool("ADD_VARIABLE_MODE")
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
    description: `Create a TEXT node. Styles apply to the whole node; ranges styles words inside it. ${RANGES_HELP}`,
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
    inputSchema: { componentId: z.string(), parentId: z.string().optional(), insertIndex: z.number().int().optional().describe("Position among the parent's children (like the other create tools); default: last."), name: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
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
      "Change properties of an existing node. Only the props you include are touched. On TEXT nodes, props.ranges styles individual words (colour, font, size, decoration), e.g. props:{ranges:[{match:\"Allāhu Akbar\", fill:{r:0.969,g:0.576,b:0.118}}]}; the result lists the styled segments. layoutPositioning must be set in the SAME call as x/y if you want a flow-managed node to become absolutely positioned at that x/y — Figma discards manual x/y on a still-flow-managed node otherwise.",
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
              "Raw Figma Paint array (gradients, multiple layers, IMAGE paints) for when `fill` (single solid colour) isn't enough. Replaces every existing fill. Each entry is a Figma Paint object as the plugin API expects it, e.g. {type:\"GRADIENT_LINEAR\", gradientStops:[...], gradientTransform:[...]} or {type:\"IMAGE\", scaleMode, imageHash}. To get a fresh imageHash from a URL, use figma_import_image instead of building this by hand; to reuse a photo already in the file, use copyFillsFrom."
            ),
          copyFillsFrom: z
            .string()
            .optional()
            .describe("Id of another node to copy fills from (e.g. to reuse an existing photo's IMAGE paint, whose imageHash isn't otherwise reachable). The source node is only read, never modified. Any IMAGE paint copied this way is set to scaleMode FILL. For a brand-new photo from a URL, use figma_import_image instead."),
          fillVariable: z.string().optional().describe("Bind fill[0] to a local colour Variable, by name (\"card\") or id. Works on TEXT too. Keeps the paint's opacity."),
          fillOpacity: z.number().min(0).max(1).optional().describe("Opacity of fill[0] (e.g. 0.3 for a scrim), with or without fillVariable."),
          strokeVariable: z.string().optional().describe("Bind stroke[0] to a local colour Variable, by name or id."),
          bindFloat: z
            .record(z.string(), z.string())
            .optional()
            .describe("Bind numeric fields to float Variables, e.g. {itemSpacing:\"spacing/3\", paddingX:\"page/padding-x\", cornerRadius:\"radius/xl\"}. Shorthands: cornerRadius (all corners), padding, paddingX, paddingY."),
          textStyle: z.string().optional().describe("Apply a local text style by name (\"body/md\") or id. On mixed text, only the main run's font gets it; inline emphasis stays as an override."),
          effectStyle: z.string().optional().describe("Apply a local effect style by name (\"shadow/md\") or id."),
          overflowDirection: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]).optional().describe("Prototype: the frame scrolls its clipped content in this direction (a page taller than the screen: VERTICAL, with clipsContent)."),
          scrollBehavior: z.enum(["SCROLLS", "FIXED", "STICKY_SCROLLS"]).optional().describe("Prototype: FIXED keeps this child in place while its frame scrolls (a bottom action bar); STICKY_SCROLLS scrolls until it reaches the edge."),
          numberOfFixedChildren: z.number().int().min(0).optional().describe("Older form of FIXED, on the frame: its last N children stay in place while it scrolls."),
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

server.registerTool(
  "figma_import_image",
  {
    description:
      "Fetch an image from a URL (e.g. a direct Unsplash photo URL — https://images.unsplash.com/... or a photo page's own direct-download link) and bring it into the file as a real IMAGE fill. If targetId is given, applies it as that node's fill directly; otherwise just returns the new imageHash to use later in figma_modify_node's raw `fills` array. This is the actual capability behind \"use the Unsplash plugin\" — there is no API to drive another Figma plugin's UI from here, but this does the same job without it. Mind Unsplash's attribution/license terms for anything beyond a mockup.",
    inputSchema: {
      url: z.string().describe("Direct image URL. Must be reachable without auth (no API key is sent)."),
      targetId: z.string().optional().describe("Node to apply the image to as a fill. Omit to just import and get back an imageHash."),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Default FILL."),
    },
  },
  tool("IMPORT_IMAGE")
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
    description: `Run many Figma edits in ONE call (up to ${MAX_OPS}), in order: create a whole section, then style and lay it out, instead of one tool call per element. Each op is {tool, args, ref?}: tool is one of ${BATCHABLE.map((t) => t.replace("figma_", "")).join(", ")} (with or without the figma_ prefix); args are that tool's own arguments; ref names the node the op creates, and later ops write "$ref" wherever they need its id (parentId, id, ...). Every op is validated before anything runs; an invalid batch changes nothing. If an op fails, ops that use its ref are skipped and the rest continue (stopOnError:true stops instead). Returns a compact report: per op ok/failed/skipped, the created ids by ref, and the errors. The report confirms what Figma did; it is not visual verification: export the finished section (figma_export_node) and look at it. Don't re-read the document after a batch just to confirm it; verify:true reads every node the batch created or changed back from Figma at the end (figma_verify_nodes) and reports any that are missing.`,
    inputSchema: {
      ops: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional(), ref: z.string().regex(/^[A-Za-z_][\w-]{0,40}$/).optional() })).min(1).max(MAX_OPS),
      stopOnError: z.boolean().optional(),
      verify: z.boolean().optional().describe("After the batch, read back every node it created or changed, and report verified:true only if all of them exist."),
    },
  },
  async ({ ops, stopOnError = false, verify = false }) => {
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
        results.push({ i: p.i, tool: p.name.replace("figma_", ""), ...(p.ref ? { ref: p.ref } : {}), status: "ok", ...(id ? { id } : {}), ...(r?.summary ? { summary: String(r.summary).replace(/^SUCCESS:\s*/, "").slice(0, 100) } : {}), ...(r?.segments ? { segments: r.segments } : {}) });
      } catch (e) {
        if (p.ref) failedRefs.add(p.ref);
        results.push({ i: p.i, tool: p.name.replace("figma_", ""), ...(p.ref ? { ref: p.ref } : {}), status: "failed", error: String(e.message || e).slice(0, 300) });
        if (stopOnError) stopped = p.i;
      }
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    const report = { ops: results.length, ok: count("ok"), failed: count("failed"), skipped: count("skipped"), created, ms: Date.now() - started,
      results, verification: "Not visually verified: these are Figma's confirmations of each edit. Export the section and look at it to verify." };
    if (verify) {
      const deleted = new Set(plan.filter((p) => p.type === "DELETE_NODE").map((p) => { const m = REF.exec(String(p.args.id || "")); return m ? created[m[1]] : p.args.id; }));
      const ids = [...new Set(results.filter((r) => r.status === "ok" && r.id && !deleted.has(r.id)).map((r) => r.id))].slice(0, 50);
      if (ids.length) { const v = await verifyNodes(ids.map((id) => ({ id }))); report.readBack = { verified: v.verified, checked: v.checked, ...(v.failed ? { failed: v.results.filter((r) => !r.ok) } : {}) }; }
    }
    return { ...(report.failed ? { isError: false } : {}), content: [{ type: "text", text: JSON.stringify(report, null, 1) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
