// Continuation of build-screen.mjs: Nav Item component set + Bottom Nav.
// Picks up where the first run stopped (root frame already exists).
const BRIDGE = "http://localhost:8787/command";
const ROOT_ID = "12007:3717";

async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${data.error}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const WHITE = { r: 1, g: 1, b: 1 };
const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };
const NAV_INACTIVE = { r: 0.9255, g: 0.9216, b: 0.9098 };

function findChild(instance, name) {
  const c = instance.children.find((c) => c.name === name);
  if (!c) throw new Error(`Instance ${instance.id} has no child named "${name}"`);
  return c;
}

async function main() {
  const navActive = await cmd("CREATE_COMPONENT", { name: "State=Active", x: -600, y: 250, fill: WHITE, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navActive.id, layoutMode: "HORIZONTAL", padding: { top: 10, bottom: 10, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: navActive.id, name: "Label", content: "Home", font: { family: "Inter", style: "Bold" }, fontSize: 13, fill: INK });

  const navInactive = await cmd("CREATE_COMPONENT", { name: "State=Inactive", x: -600, y: 320, fill: TRANSPARENT, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navInactive.id, layoutMode: "HORIZONTAL", padding: { top: 10, bottom: 10, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: navInactive.id, name: "Label", content: "Applications", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: NAV_INACTIVE });

  await cmd("COMBINE_AS_VARIANTS", { componentIds: [navActive.id, navInactive.id], name: "Nav Item" });

  const navBar = await cmd("CREATE_FRAME", { parentId: ROOT_ID, name: "Bottom Nav", fill: INK, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navBar.id, layoutMode: "HORIZONTAL", itemSpacing: 4, paddingAll: 6, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });

  await cmd("CREATE_INSTANCE", { componentId: navActive.id, parentId: navBar.id, name: "Home" });
  await cmd("CREATE_INSTANCE", { componentId: navInactive.id, parentId: navBar.id, name: "Applications" });
  const profileInstance = await cmd("CREATE_INSTANCE", { componentId: navInactive.id, parentId: navBar.id, name: "Profile" });
  await cmd("MODIFY_NODE", { id: findChild(profileInstance, "Label").id, props: { characters: "Profile" } });

  await cmd("MODIFY_NODE", { id: navBar.id, props: { layoutPositioning: "ABSOLUTE" } });
  const navBarState = await cmd("GET_DOCUMENT_STATE", { id: navBar.id, depth: 0 });
  const navW = navBarState.node.width;
  const navH = navBarState.node.height;
  await cmd("MODIFY_NODE", { id: navBar.id, props: { x: Math.round((422 - navW) / 2), y: 672 - navH - 24 } });

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
