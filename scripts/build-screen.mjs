// Builds the "What do you need help with?" mobile screen through the
// Executor — a deterministic sequence of the same bridge calls that could be
// issued one-by-one over curl. No LLM involved; this is the AI's plan,
// expressed as calls, not an autonomous agent.
//
// Usage: node build-screen.mjs

const BRIDGE = "http://localhost:8787/command";

async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, params }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${data.error}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

// --- Measured design tokens (sampled from the source screenshot) ----------
const BG = { r: 0.9686, g: 0.9647, b: 0.9529 };
const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const MUTED = { r: 0.4706, g: 0.4667, b: 0.4353 };
const AMBER = { r: 0.851, g: 0.4745, b: 0.0549 };
const INDIGO = { r: 0.2392, g: 0.3059, b: 0.9098 };
const SPEAK_BG = { r: 0.9333, g: 0.9294, b: 0.9137 };
const WHITE = { r: 1, g: 1, b: 1 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };
const NAV_INACTIVE = { r: 0.9255, g: 0.9216, b: 0.9098 };

// Figma's vectorPaths parser only accepts M/L/C/Z (no arc command "A" at
// all — confirmed by trial), unlike a browser's SVG parser. Arcs below are
// approximated with a single cubic bezier per curve (control points at
// chord_endpoint +/- 4/3*radius, perpendicular to the chord).
const MIC_PATH =
  "M 9 4 C 9 0 15 0 15 4 L 15 9 C 15 13 9 13 9 9 Z " +
  "M 19 10 L 19 12 C 19 21.33 5 21.33 5 12 L 5 10 " +
  "M 12 19 L 12 23 " +
  "M 8 23 L 16 23";
const SEND_PATH = "M 22 2 L 11 13 M 22 2 L 15 22 L 11 13 L 2 9 Z";

const CARD_SHADOW = { color: { r: 0, g: 0, b: 0, a: 0.06 }, x: 0, y: 8, blur: 24, spread: 0 };

function findChild(instance, name) {
  const c = instance.children.find((c) => c.name === name);
  if (!c) throw new Error(`Instance ${instance.id} has no child named "${name}"`);
  return c;
}

async function main() {
  const root = await cmd("CREATE_FRAME", { name: "Home Screen", width: 422, height: 672, x: 0, y: 0, fill: BG });
  await cmd("SET_AUTO_LAYOUT", {
    id: root.id,
    layoutMode: "VERTICAL",
    itemSpacing: 24,
    padding: { top: 40, right: 24, bottom: 24, left: 24 },
    primaryAxisSizingMode: "FIXED",
    counterAxisSizingMode: "FIXED",
  });

  // --- Header ---------------------------------------------------------
  const header = await cmd("CREATE_FRAME", { parentId: root.id, name: "Header", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: header.id, layoutMode: "VERTICAL", itemSpacing: 14, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: header.id, props: { layoutSizingHorizontal: "FILL" } });

  const headline = await cmd("CREATE_FRAME", { parentId: header.id, name: "Headline", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: headline.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: headline.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_TEXT", { parentId: headline.id, name: "Line 1", content: "What do you", font: { family: "Georgia", style: "Bold" }, fontSize: 34, fill: INK });
  await cmd("CREATE_TEXT", { parentId: headline.id, name: "Line 2", content: "need help with?", font: { family: "Georgia", style: "Bold Italic" }, fontSize: 34, fill: INK });

  await cmd("CREATE_TEXT", {
    parentId: header.id, name: "Subtext",
    content: "Tell me in plain language — I'll handle the rest.",
    font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: MUTED,
  });

  // --- Button component set (Style=Primary / Style=Secondary) ---------
  const btnPrimary = await cmd("CREATE_COMPONENT", { name: "Style=Primary", x: -600, y: 0, fill: INDIGO, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnPrimary.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 10, bottom: 10, left: 16, right: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_VECTOR", { parentId: btnPrimary.id, name: "Icon", path: SEND_PATH, strokeColor: WHITE, strokeWeight: 2, width: 16, height: 16 });
  await cmd("CREATE_TEXT", { parentId: btnPrimary.id, name: "Label", content: "Send", font: { family: "Inter", style: "Bold" }, fontSize: 14, fill: WHITE });

  const btnSecondary = await cmd("CREATE_COMPONENT", { name: "Style=Secondary", x: -600, y: 100, fill: SPEAK_BG, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: btnSecondary.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 10, bottom: 10, left: 16, right: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_VECTOR", { parentId: btnSecondary.id, name: "Icon", path: MIC_PATH, strokeColor: INK, strokeWeight: 2, width: 16, height: 16 });
  await cmd("CREATE_TEXT", { parentId: btnSecondary.id, name: "Label", content: "Speak", font: { family: "Inter", style: "Bold" }, fontSize: 14, fill: INK });

  await cmd("COMBINE_AS_VARIANTS", { componentIds: [btnPrimary.id, btnSecondary.id], name: "Button" });

  // --- Input Card -------------------------------------------------------
  const card1 = await cmd("CREATE_FRAME", { parentId: root.id, name: "Input Card", fill: WHITE, cornerRadius: 24, dropShadow: CARD_SHADOW });
  await cmd("SET_AUTO_LAYOUT", { id: card1.id, layoutMode: "VERTICAL", itemSpacing: 16, paddingAll: 20, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: card1.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_TEXT", {
    parentId: card1.id, name: "Placeholder",
    content: "I need to apply for a Brazilian tourist visa…",
    font: { family: "Inter", style: "Regular" }, fontSize: 15, fill: { r: 0.82, g: 0.82, b: 0.82 },
  });

  const inputRow = await cmd("CREATE_FRAME", { parentId: card1.id, name: "Input Actions Row", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: inputRow.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: inputRow.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_INSTANCE", { componentId: btnSecondary.id, parentId: inputRow.id, name: "Speak Button" });
  await cmd("CREATE_INSTANCE", { componentId: btnPrimary.id, parentId: inputRow.id, name: "Send Button" });

  // --- Active Application Card ------------------------------------------
  const card2 = await cmd("CREATE_FRAME", { parentId: root.id, name: "Active Application Card", fill: WHITE, cornerRadius: 24, dropShadow: CARD_SHADOW });
  await cmd("SET_AUTO_LAYOUT", { id: card2.id, layoutMode: "VERTICAL", itemSpacing: 6, paddingAll: 20, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: card2.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_TEXT", {
    parentId: card2.id, name: "Eyebrow Label", content: "ACTIVE APPLICATION",
    font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: MUTED, letterSpacing: { value: 1.2, unit: "PIXELS" },
  });
  await cmd("CREATE_TEXT", { parentId: card2.id, name: "Title", content: "Brazilian Tourist Visa", font: { family: "Inter", style: "Bold" }, fontSize: 19, fill: INK });

  const statusRow = await cmd("CREATE_FRAME", { parentId: card2.id, name: "Status Row", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: statusRow.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: statusRow.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_TEXT", { parentId: statusRow.id, name: "Status", content: "Waiting for 1 document", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: AMBER });

  const continueInstance = await cmd("CREATE_INSTANCE", { componentId: btnPrimary.id, parentId: statusRow.id, name: "Continue Button" });
  const continueIcon = findChild(continueInstance, "Icon");
  const continueLabel = findChild(continueInstance, "Label");
  await cmd("MODIFY_NODE", { id: continueIcon.id, props: { visible: false } });
  await cmd("MODIFY_NODE", { id: continueLabel.id, props: { characters: "Continue" } });

  // --- Nav Item component set (State=Active / State=Inactive) -----------
  const navActive = await cmd("CREATE_COMPONENT", { name: "State=Active", x: -600, y: 250, fill: WHITE, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navActive.id, layoutMode: "HORIZONTAL", padding: { top: 10, bottom: 10, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: navActive.id, name: "Label", content: "Home", font: { family: "Inter", style: "Bold" }, fontSize: 13, fill: INK });

  const navInactive = await cmd("CREATE_COMPONENT", { name: "State=Inactive", x: -600, y: 320, fill: TRANSPARENT, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navInactive.id, layoutMode: "HORIZONTAL", padding: { top: 10, bottom: 10, left: 20, right: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("CREATE_TEXT", { parentId: navInactive.id, name: "Label", content: "Applications", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: NAV_INACTIVE });

  await cmd("COMBINE_AS_VARIANTS", { componentIds: [navActive.id, navInactive.id], name: "Nav Item" });

  // --- Bottom Nav ---------------------------------------------------------
  const navBar = await cmd("CREATE_FRAME", { parentId: root.id, name: "Bottom Nav", fill: INK, cornerRadius: 999 });
  await cmd("SET_AUTO_LAYOUT", { id: navBar.id, layoutMode: "HORIZONTAL", itemSpacing: 4, paddingAll: 6, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });

  await cmd("CREATE_INSTANCE", { componentId: navActive.id, parentId: navBar.id, name: "Home" });
  const appsInstance = await cmd("CREATE_INSTANCE", { componentId: navInactive.id, parentId: navBar.id, name: "Applications" });
  const profileInstance = await cmd("CREATE_INSTANCE", { componentId: navInactive.id, parentId: navBar.id, name: "Profile" });
  await cmd("MODIFY_NODE", { id: findChild(profileInstance, "Label").id, props: { characters: "Profile" } });

  // Pull the nav bar out of the vertical flow and pin it near the bottom,
  // centered — its size depends on its own content, so measure first.
  await cmd("MODIFY_NODE", { id: navBar.id, props: { layoutPositioning: "ABSOLUTE" } });
  const navBarState = await cmd("GET_DOCUMENT_STATE", { id: navBar.id, depth: 0 });
  const navW = navBarState.node.width;
  const navH = navBarState.node.height;
  await cmd("MODIFY_NODE", { id: navBar.id, props: { x: Math.round((422 - navW) / 2), y: 672 - navH - 24 } });

  console.log("\nRoot frame id:", root.id);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
