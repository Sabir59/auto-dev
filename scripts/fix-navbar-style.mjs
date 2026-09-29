// Rebuild the bottom nav to match the reference's actual style: a dark
// floating pill, text-only tabs (no icons), not a full-width white bar.
const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const WHITE = { r: 1, g: 1, b: 1 };
const NAV_INACTIVE = { r: 0.68, g: 0.68, b: 0.7 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };

const OLD_NAV_IDS = ["14006:204", "14006:310", "14006:549", "14006:612", "14006:630", "14006:693"];
const SCREENS = [
  { screen: "14006:177", active: "Home" },
  { screen: "14006:259", active: "Applications" },
  { screen: "14006:525", active: "Applications" },
  { screen: "14006:574", active: "Applications" },
  { screen: "14006:622", active: "Applications" },
  { screen: "14006:683", active: "Profile" },
];
const TABS = ["Home", "Applications", "Profile"];

async function buildNav(screenId, activeTab) {
  const nav = await cmd("CREATE_FRAME", { parentId: screenId, name: "Bottom Nav", fill: INK, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: nav.id, layoutMode: "HORIZONTAL", itemSpacing: 4, padding: { top: 6, right: 6, bottom: 6, left: 6 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });

  for (const tab of TABS) {
    const isActive = tab === activeTab;
    const pill = await cmd("CREATE_FRAME", { parentId: nav.id, name: tab, fill: isActive ? WHITE : TRANSPARENT, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: pill.id, layoutMode: "HORIZONTAL", padding: { top: 10, right: 18, bottom: 10, left: 18 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_TEXT", { parentId: pill.id, name: "Label", content: tab, font: { family: "Inter", style: isActive ? "Bold" : "Regular" }, fontSize: 14, fill: isActive ? INK : NAV_INACTIVE });
  }

  await cmd("MODIFY_NODE", { id: nav.id, props: { layoutPositioning: "ABSOLUTE" } });
  const state = await cmd("GET_DOCUMENT_STATE", { id: nav.id, depth: 0 });
  const w = state.node.width, h = state.node.height;
  await cmd("MODIFY_NODE", { id: nav.id, props: { x: Math.round((390 - w) / 2), y: 844 - h - 24 } });
}

async function main() {
  for (const id of OLD_NAV_IDS) await cmd("DELETE_NODE", { id });
  for (const s of SCREENS) await buildNav(s.screen, s.active);
}
main().catch((e) => { console.error(e); process.exit(1); });
