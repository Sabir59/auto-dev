// Continuation: finish nav tab components on the Components page.
const BRIDGE = "http://localhost:8787/command";
const COMPONENTS_PAGE = "14006:152";

async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${data.error}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const WHITE = { r: 1, g: 1, b: 1 };
const MUTED_NAV = { r: 0.6, g: 0.6, b: 0.62 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };
const HOUSE_PATH = "M 3 11 L 12 3 L 21 11 L 21 21 L 3 21 Z M 9 21 L 9 14 L 15 14 L 15 21";
const DOC_PATH = "M 6 2 L 16 2 L 20 6 L 20 22 L 6 22 Z M 16 2 L 16 6 L 20 6 M 9 12 L 17 12 M 9 16 L 17 16";
const USER_PATH = "M 9 7 C 9 3.7 10.7 2 12 2 C 13.3 2 15 3.7 15 7 C 15 10.3 13.3 12 12 12 C 10.7 12 9 10.3 9 7 Z M 4 21 C 4 16 7.5 14 12 14 C 16.5 14 20 16 20 21 Z";

async function buildTab(name, label, path, active, y) {
  const c = await cmd("CREATE_COMPONENT", { parentId: COMPONENTS_PAGE, name, x: 0, y, fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: c.id, layoutMode: "VERTICAL", itemSpacing: 2, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_VECTOR", { parentId: c.id, name: "Icon", path, strokeColor: active ? { r: 0.0941, g: 0.0941, b: 0.102 } : MUTED_NAV, strokeWeight: 2, width: 20, height: 20 });
  await cmd("CREATE_TEXT", { parentId: c.id, name: "Label", content: label, font: { family: "Inter", style: active ? "Bold" : "Regular" }, fontSize: 11, fill: active ? { r: 0.0941, g: 0.0941, b: 0.102 } : MUTED_NAV });
  return c;
}

async function main() {
  // Finish Home=Active's missing label (icon already exists at 14006:150 -> 14006:151)
  await cmd("CREATE_TEXT", { parentId: "14006:150", name: "Label", content: "Home", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: { r: 0.0941, g: 0.0941, b: 0.102 } });

  const homeInactive = await buildTab("Home=Inactive", "Home", HOUSE_PATH, false, 60);
  const appsActive = await buildTab("Applications=Active", "Applications", DOC_PATH, true, 120);
  const appsInactive = await buildTab("Applications=Inactive", "Applications", DOC_PATH, false, 180);
  const profileActive = await buildTab("Profile=Active", "Profile", USER_PATH, true, 240);
  const profileInactive = await buildTab("Profile=Inactive", "Profile", USER_PATH, false, 300);

  const navSet = await cmd("COMBINE_AS_VARIANTS", {
    componentIds: ["14006:150", homeInactive.id, appsActive.id, appsInactive.id, profileActive.id, profileInactive.id],
    parentId: COMPONENTS_PAGE,
    name: "NavTab",
  });

  console.log("\n--- IDS ---");
  console.log(JSON.stringify({
    navSet: navSet.id,
    homeActive: "14006:150", homeInactive: homeInactive.id,
    appsActive: appsActive.id, appsInactive: appsInactive.id,
    profileActive: profileActive.id, profileInactive: profileInactive.id,
  }, null, 2));
}

main().catch((err) => { console.error("Build failed:", err); process.exit(1); });
