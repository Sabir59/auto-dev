const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const TARGET_HEIGHT = 844;

// Screens under 844, with their Bottom Nav child id if one exists (null if not).
const SCREENS = [
  { id: "14006:259", nav: null }, // 03 Documents — will look up nav below
  { id: "14006:320", nav: null }, // 04a
  { id: "14006:360", nav: null }, // 04b
  { id: "14006:390", nav: null }, // 05a
  { id: "14006:423", nav: null }, // 05b
  { id: "14006:450", nav: null }, // 06
  { id: "14006:485", nav: null }, // 07 Submitting — no nav
  { id: "14006:510", nav: null }, // 08 OTP — no nav
  { id: "14006:559", nav: null }, // 10 Error — no nav
  { id: "14006:640", nav: null }, // 12 Details
];

async function findNav(screenId) {
  const state = await cmd("GET_DOCUMENT_STATE", { id: screenId, depth: 1 });
  const nav = state.node.children.find((c) => c.name === "Bottom Nav");
  return nav ? nav.id : null;
}

async function main() {
  for (const s of SCREENS) {
    const navId = await findNav(s.id);

    // Force the frame to a fixed 844 height regardless of its current
    // auto-layout sizing mode.
    await cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "MIN" });
    await cmd("MODIFY_NODE", { id: s.id, props: { width: 390, height: TARGET_HEIGHT } });

    if (navId) {
      const navState = await cmd("GET_DOCUMENT_STATE", { id: navId, depth: 0 });
      const navW = navState.node.width, navH = navState.node.height;
      await cmd("MODIFY_NODE", { id: navId, props: { x: Math.round((390 - navW) / 2), y: TARGET_HEIGHT - navH - 24 } });
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
