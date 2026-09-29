// Builds the core reusable component library for the Visa AI Agent file.
const BRIDGE = "http://localhost:8787/command";

async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${data.error}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

// --- Palette ---------------------------------------------------------
const BG = { r: 0.9686, g: 0.9647, b: 0.9529 };
const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const MUTED = { r: 0.4706, g: 0.4667, b: 0.4353 };
const PRIMARY = { r: 0.2392, g: 0.3059, b: 0.9098 };
const WARNING_BG = { r: 0.9961, g: 0.9529, b: 0.7804 };
const WARNING_BORDER = { r: 0.9176, g: 0.7686, b: 0.5333 };
const AMBER_TEXT = { r: 0.851, g: 0.4745, b: 0.0549 };
const DESTRUCTIVE_ACTION = { r: 0.851, g: 0.4667, b: 0.0235 };
const SUCCESS_BG = { r: 0.8627, g: 0.9882, b: 0.9059 };
const SUCCESS_TEXT = { r: 0.0863, g: 0.3922, b: 0.2039 };
const WHITE = { r: 1, g: 1, b: 1 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };
const SPEAK_BG = { r: 0.9333, g: 0.9294, b: 0.9137 };
const CARD_BORDER = { r: 0.9216, g: 0.9098, b: 0.8824 };
const DARK_NAV = { r: 0.0941, g: 0.0941, b: 0.102 };

const CHECK_PATH = "M 20 6 L 9 17 L 4 12";
const CHEVRON_LEFT_PATH = "M 15 18 L 9 12 L 15 6";
const CHEVRON_RIGHT_PATH = "M 9 18 L 15 12 L 9 6";
const PLUS_PATH = "M 12 5 L 12 19 M 5 12 L 19 12";
const WARNING_PATH = "M 12 2 L 22 20 L 2 20 Z M 12 9 L 12 13 M 12 16.4 L 12 16.5";
const SEND_PATH = "M 22 2 L 11 13 M 22 2 L 15 22 L 11 13 L 2 9 Z";
const MIC_PATH = "M 9 4 C 9 0 15 0 15 4 L 15 9 C 15 13 9 13 9 9 Z M 19 10 L 19 12 C 19 21.33 5 21.33 5 12 L 5 10 M 12 19 L 12 23 M 8 23 L 16 23";
const HOUSE_PATH = "M 3 11 L 12 3 L 21 11 L 21 21 L 3 21 Z M 9 21 L 9 14 L 15 14 L 15 21";
const DOC_PATH = "M 6 2 L 16 2 L 20 6 L 20 22 L 6 22 Z M 16 2 L 16 6 L 20 6 M 9 12 L 17 12 M 9 16 L 17 16";
const USER_PATH = "M 9 7 C 9 3.7 10.7 2 12 2 C 13.3 2 15 3.7 15 7 C 15 10.3 13.3 12 12 12 C 10.7 12 9 10.3 9 7 Z M 4 21 C 4 16 7.5 14 12 14 C 16.5 14 20 16 20 21 Z";

const out = {};

async function main() {
  // ---- Button component set: Primary / Secondary / Ghost / Destructive
  const btnPrimary = await cmd("CREATE_COMPONENT", { name: "Style=Primary", x: -2000, y: 0, fill: PRIMARY, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnPrimary.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 14, bottom: 14, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: btnPrimary.id, name: "Label", content: "Button", font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: WHITE });

  const btnSecondary = await cmd("CREATE_COMPONENT", { name: "Style=Secondary", x: -2000, y: 100, fill: { r: 0.902, g: 0.902, b: 0.902 }, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnSecondary.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 14, bottom: 14, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: btnSecondary.id, name: "Label", content: "Button", font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: INK });

  const btnGhost = await cmd("CREATE_COMPONENT", { name: "Style=Ghost", x: -2000, y: 200, fill: TRANSPARENT, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnGhost.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 14, bottom: 14, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: btnGhost.id, name: "Label", content: "Button", font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: INK });

  const btnDestructive = await cmd("CREATE_COMPONENT", { name: "Style=Destructive", x: -2000, y: 300, fill: DESTRUCTIVE_ACTION, cornerRadius: 9999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnDestructive.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 10, bottom: 10, left: 16, right: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: btnDestructive.id, name: "Label", content: "Button", font: { family: "Inter", style: "Medium" }, fontSize: 14, fill: WHITE });

  const buttonSet = await cmd("COMBINE_AS_VARIANTS", { componentIds: [btnPrimary.id, btnSecondary.id, btnGhost.id, btnDestructive.id], name: "Button" });
  out.btnPrimary = btnPrimary.id; out.btnSecondary = btnSecondary.id; out.btnGhost = btnGhost.id; out.btnDestructive = btnDestructive.id;

  // ---- StatusPill component set: variants by status
  const statuses = [
    { key: "InProgress", label: "In progress", bg: WARNING_BG, text: AMBER_TEXT },
    { key: "Submitted", label: "Submitted", bg: { r: 0.898, g: 0.906, b: 0.98 }, text: PRIMARY },
    { key: "Completed", label: "Completed", bg: SUCCESS_BG, text: SUCCESS_TEXT },
    { key: "NeedsReview", label: "Needs review", bg: WARNING_BG, text: AMBER_TEXT },
    { key: "Uploaded", label: "Uploaded", bg: TRANSPARENT, text: PRIMARY },
    { key: "Verified", label: "Verified", bg: SUCCESS_BG, text: SUCCESS_TEXT },
  ];
  const pillIds = [];
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    const p = await cmd("CREATE_COMPONENT", { name: `Status=${s.key}`, x: -2000, y: 400 + i * 60, fill: s.bg, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: p.id, layoutMode: "HORIZONTAL", padding: { top: 4, bottom: 4, left: 10, right: 10 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
    await cmd("CREATE_TEXT", { parentId: p.id, name: "Label", content: s.label, font: { family: "Inter", style: "Medium" }, fontSize: 12, fill: s.text });
    pillIds.push(p.id);
    out[`pill${s.key}`] = p.id;
  }
  await cmd("COMBINE_AS_VARIANTS", { componentIds: pillIds, name: "StatusPill" });

  // ---- BottomNav component set: 3 active-tab variants
  async function buildNavTabActive(name, label, path, x, y) {
    const c = await cmd("CREATE_COMPONENT", { name, x: -2000, y, fill: TRANSPARENT });
    await cmd("SET_AUTO_LAYOUT", { id: c.id, layoutMode: "VERTICAL", itemSpacing: 2, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_VECTOR", { parentId: c.id, name: "Icon", path, strokeColor: isActive(name) ? WHITE : { r: 0.6, g: 0.6, b: 0.62 }, strokeWeight: 2, width: 20, height: 20 });
    await cmd("CREATE_TEXT", { parentId: c.id, name: "Label", content: label, font: { family: "Inter", style: isActive(name) ? "Bold" : "Regular" }, fontSize: 11, fill: isActive(name) ? WHITE : { r: 0.6, g: 0.6, b: 0.62 } });
    return c;
  }
  function isActive(name) { return name.includes("Active"); }

  // Build 6 raw tab components (Home/Applications/Profile x Active/Inactive)
  const navHomeActive = await buildNavTabActive("Home=Active", "Home", HOUSE_PATH, 0, 500);
  const navHomeInactive = await buildNavTabActive("Home=Inactive", "Home", HOUSE_PATH, 0, 560);
  const navAppsActive = await buildNavTabActive("Applications=Active", "Applications", DOC_PATH, 0, 620);
  const navAppsInactive = await buildNavTabActive("Applications=Inactive", "Applications", DOC_PATH, 0, 680);
  const navProfileActive = await buildNavTabActive("Profile=Active", "Profile", USER_PATH, 0, 740);
  const navProfileInactive = await buildNavTabActive("Profile=Inactive", "Profile", USER_PATH, 0, 800);

  out.navHomeActive = navHomeActive.id; out.navHomeInactive = navHomeInactive.id;
  out.navAppsActive = navAppsActive.id; out.navAppsInactive = navAppsInactive.id;
  out.navProfileActive = navProfileActive.id; out.navProfileInactive = navProfileInactive.id;

  console.log("\n--- IDS ---");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error("Build failed:", err); process.exit(1); });
