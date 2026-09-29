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
const TABS = ["Home", "Applications", "Profile"];

// Screens with direct reference precedent showing the nav present during
// the sub-flow (Documents/Validation/Summary/Review/Details all show it
// in the original samples) — Submitting/OTP/Error are new, invented
// screens with no reference precedent, and are transient/blocking states
// where a tab bar is arguably wrong anyway, so left without one.
const SCREENS = ["14006:320", "14006:360", "14006:390", "14006:423", "14006:450", "14006:640"];

async function buildNav(screenId) {
  // Measure the screen's actual current (auto-hugged) height BEFORE adding
  // the nav, since these frames aren't fixed at 844 like the top-level ones.
  const before = await cmd("GET_DOCUMENT_STATE", { id: screenId, depth: 0 });
  const contentHeight = before.node.height;

  const nav = await cmd("CREATE_FRAME", { parentId: screenId, name: "Bottom Nav", fill: INK, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: nav.id, layoutMode: "HORIZONTAL", itemSpacing: 4, padding: { top: 6, right: 6, bottom: 6, left: 6 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  for (const tab of TABS) {
    const isActive = tab === "Applications";
    const pill = await cmd("CREATE_FRAME", { parentId: nav.id, name: tab, fill: isActive ? WHITE : TRANSPARENT, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: pill.id, layoutMode: "HORIZONTAL", padding: { top: 10, right: 18, bottom: 10, left: 18 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_TEXT", { parentId: pill.id, name: "Label", content: tab, font: { family: "Inter", style: isActive ? "Bold" : "Regular" }, fontSize: 14, fill: isActive ? INK : NAV_INACTIVE });
  }
  await cmd("MODIFY_NODE", { id: nav.id, props: { layoutPositioning: "ABSOLUTE" } });
  const navState = await cmd("GET_DOCUMENT_STATE", { id: nav.id, depth: 0 });
  const navW = navState.node.width, navH = navState.node.height;
  const gapAbove = 24, gapBelow = 24;
  const navY = contentHeight + gapAbove;
  await cmd("MODIFY_NODE", { id: nav.id, props: { x: Math.round((390 - navW) / 2), y: navY } });

  // Grow the screen frame itself to actually contain the nav (auto-hug
  // ignores absolutely-positioned children, so this must be explicit).
  await cmd("MODIFY_NODE", { id: screenId, props: { height: navY + navH + gapBelow } });
}

async function main() {
  for (const id of SCREENS) await buildNav(id);
}
main().catch((e) => { console.error(e); process.exit(1); });
