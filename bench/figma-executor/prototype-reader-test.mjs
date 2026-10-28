// The plugin's prototype reader (plugin/code.js GET_PROTOTYPE), run offline: the real plugin code in a
// sandbox with a stand-in Figma document laid out like a real design file — screens inside a section,
// a modal in a nested section, the click wiring on a button inside a card instance, a desktop and a
// mobile frame with the same name, a timed link and a link to a URL. Nothing reaches Figma.
//   node bench/figma-executor/prototype-reader-test.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1200)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

// ---- the stand-in document ----
const byId = new Map();
function node(id, type, name, extra = {}, children = []) {
  const n = { id, type, name, reactions: [], ...extra };
  if (type !== "TEXT" && type !== "RECTANGLE") n.children = children;
  for (const c of children) c.parent = n;
  byId.set(id, n);
  return n;
}
const click = (destinationId, navigation = "NAVIGATE", transition = null) => ({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId, navigation, transition }] });
let loaded = false;
const page = node("5:19051", "PAGE", "Build Like You Believe", { flowStartingPoints: [{ nodeId: "6002:1569", name: "Flow 1" }], loadAsync: async () => { loaded = true; } }, [
  node("6002:1568", "SECTION", "1536P Screen Dimensions", {}, [
    node("6002:1569", "FRAME", "Desktop", {}, [
      node("6002:1640", "FRAME", "Projects", {}, [
        node("6002:1655", "INSTANCE", "Project Card", {}, [
          node("6002:1665", "TEXT", "Lets Build Al-Alami Masjid"),
          node("I6002:1655;1:9", "FRAME", "Button", { reactions: [click("6002:2194", "OVERLAY", { type: "DISSOLVE", duration: 0.30000001192092896 })] }, [node("I6002:1655;1:10", "TEXT", "Label")]),
        ]),
      ]),
    ]),
    node("6002:2190", "SECTION", "Modals", {}, [
      node("6002:2194", "FRAME", "Project Full Details", {}, [
        node("6002:2300", "FRAME", "Lets build Al-Alami masjid", { reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "SET_VARIABLE", variableId: "VariableID:1:2" }] }] }),
        node("6002:2301", "FRAME", "Close", { reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CLOSE" }] }] }),
      ]),
    ]),
    node("6002:2000", "FRAME", "Desktop", { reactions: [{ trigger: { type: "AFTER_TIMEOUT", timeout: 0.8 }, actions: [{ type: "NODE", destinationId: "6002:1569", navigation: "NAVIGATE", transition: null }] }] }, []),
  ]),
  node("7:1", "FRAME", "Footer", {}, [node("7:2", "FRAME", "Website", { reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "URL", url: "https://matwproject.org" }] }] })]),
  node("7:3", "FRAME", "Empty screen", {}, []),
]);

// ---- the plugin, as Figma runs it ----
const posted = [];
const figma = {
  showUI() {}, ui: { postMessage: (m) => posted.push(m), onmessage: null },
  root: { id: "0:0", name: "MATW Local", children: [page] }, fileKey: "TwGIqdVfn71XyrcwbYGtOE", editorType: "figma",
  currentPage: page, on() {}, getNodeByIdAsync: async (id) => byId.get(id) || null,
};
vm.runInNewContext(readFileSync(join(REPO, "plugin", "code.js"), "utf8"), { figma, __html__: "", console, setTimeout, clearTimeout, Promise });
let n = 0;
async function command(type, params) {
  const id = `c${++n}`;
  await figma.ui.onmessage({ id, type, params });
  const r = posted.find((m) => m.id === id);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

let whole;
await step("screens inside sections (and nested sections) are found; their wiring is read at any depth, a button inside a card instance included, with the layer's id and the destination's name and id", async () => {
  whole = await command("GET_PROTOTYPE", { pageId: "5:19051" });
  const desktop = whole.screens["Desktop"] || [], btn = desktop.find((e) => e.id === "I6002:1655;1:9");
  assert(loaded, "the page wasn't loaded first (dynamic-page)");
  assert(btn && btn.on === "Desktop › Projects › Project Card › Button" && btn.trigger === "on_click" && btn.action === "overlay" && btn.to === "Project Full Details" && btn.toId === "6002:2194" && btn.transition === "dissolve 0.3s", { desktop });
  return { screens: Object.keys(whole.screens), button: btn };
});
await step("every kind of action is described: close overlay, set a variable, open a URL, a timed link (its delay in ms); the screen's own reactions are included", async () => {
  const modal = whole.screens["Project Full Details"] || [], mobile = whole.screens["Desktop (6002:2000)"] || [], footer = whole.screens["Footer"] || [];
  assert(modal.some((e) => e.action === "set_variable" && e.variableId === "VariableID:1:2") && modal.some((e) => e.action === "close overlay"), modal);
  assert(mobile.length === 1 && mobile[0].on === "Desktop" && mobile[0].trigger === "after_timeout" && mobile[0].delay === 800 && mobile[0].toId === "6002:1569", mobile);
  assert(footer[0]?.action === "open_url" && footer[0].url === "https://matwproject.org", footer);
  return { modal: modal.map((e) => e.action), timed: mobile[0], url: footer[0].url };
});
await step("two screens with the same name are both kept (the second keyed with its id); the index lists every screen with its section and reaction count, so 'no reactions' is visible as such; the flow start is reported", async () => {
  const idx = Object.fromEntries(whole.index.map((s) => [s.id, s]));
  assert(whole.screens["Desktop"] && whole.screens["Desktop (6002:2000)"], Object.keys(whole.screens));
  assert(idx["6002:1569"].section === "1536P Screen Dimensions" && idx["6002:2194"].section === "1536P Screen Dimensions › Modals" && idx["7:3"].reactions === 0 && !whole.screens["Empty screen"], whole.index);
  assert(whole.flows.length === 1 && whole.flows[0].nodeId === "6002:1569", whole.flows);
  return { index: whole.index };
});
await step("nodeId reads just one part: a section, a card instance, or one button by its instance-sublayer id; the page's flows still come with it", async () => {
  const section = await command("GET_PROTOTYPE", { nodeId: "6002:2190" }), card = await command("GET_PROTOTYPE", { nodeId: "6002:1655" }), button = await command("GET_PROTOTYPE", { nodeId: "I6002:1655;1:9" });
  assert(Object.keys(section.screens).join() === "Project Full Details" && section.index[0].section === "Modals", section);
  assert(card.screens["Project Card"]?.[0]?.to === "Project Full Details" && button.screens["Button"]?.[0]?.toId === "6002:2194" && button.flows[0]?.nodeId === "6002:1569", { card, button });
  return { section: Object.keys(section.screens), card: card.screens["Project Card"][0].on, button: button.screens["Button"][0].action };
});
await step("refused clearly: neither a page nor a node, or a node that doesn't exist", async () => {
  const bad = await command("GET_PROTOTYPE", { pageId: "6002:1569" }).then(() => null, (e) => e.message);
  const missing = await command("GET_PROTOTYPE", { nodeId: "9:9" }).then(() => null, (e) => e.message);
  assert(/is not a page/.test(bad || "") && /not found/.test(missing || ""), { bad, missing });
  return { bad, missing };
});

writeFileSync(join(HERE, "prototype-reader-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
