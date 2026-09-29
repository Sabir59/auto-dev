const BRIDGE = "http://localhost:8787/command";
const SCREENS_PAGE = "12002:3691";

async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)} | ${JSON.stringify(params).slice(0, 200)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}
function findChild(instance, name) {
  const c = instance.children.find((c) => c.name === name);
  if (!c) throw new Error(`Instance ${instance.id} has no child "${name}" (has: ${instance.children.map((c) => c.name).join(", ")})`);
  return c;
}

// --- Palette ---
const BG = { r: 0.9686, g: 0.9647, b: 0.9529 };
const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const MUTED = { r: 0.4706, g: 0.4667, b: 0.4353 };
const PRIMARY = { r: 0.2392, g: 0.3059, b: 0.9098 };
const WARNING_BG = { r: 0.9961, g: 0.9529, b: 0.7804 };
const WARNING_BORDER = { r: 0.9176, g: 0.7686, b: 0.5333 };
const AMBER_TEXT = { r: 0.851, g: 0.4745, b: 0.0549 };
const SUCCESS_BG = { r: 0.8627, g: 0.9882, b: 0.9059 };
const SUCCESS_TEXT = { r: 0.0863, g: 0.3922, b: 0.2039 };
const WHITE = { r: 1, g: 1, b: 1 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };
const CARD_BORDER = { r: 0.9216, g: 0.9098, b: 0.8824 };
const CARD_SHADOW = { color: { r: 0, g: 0, b: 0, a: 0.05 }, x: 0, y: 2, blur: 8, spread: 0 };
const LIGHT_GRAY_BG = { r: 0.902, g: 0.902, b: 0.902 };

// Component ids from visa-components.mjs / part2
const IDS = {
  btnPrimary: "14006:128", btnSecondary: "14006:130", btnGhost: "14006:132", btnDestructive: "14006:134",
  pillInProgress: "14006:137", pillSubmitted: "14006:139", pillCompleted: "14006:141",
  pillNeedsReview: "14006:143", pillUploaded: "14006:145", pillVerified: "14006:147",
  navHomeActive: "14006:150", navHomeInactive: "14006:155",
  navAppsActive: "14006:158", navAppsInactive: "14006:161",
  navProfileActive: "14006:164", navProfileInactive: "14006:167",
};

const CHECK_PATH = "M 20 6 L 9 17 L 4 12";
const CHEVRON_LEFT_PATH = "M 15 18 L 9 12 L 15 6";
const WARNING_PATH = "M 12 2 L 22 20 L 2 20 Z M 12 9 L 12 13 M 12 16.4 L 12 16.5";
const CIRCLE_PATH = "M 12 2 C 5.4 2 2 5.4 2 12 C 2 18.6 5.4 22 12 22 C 18.6 22 22 18.6 22 12 C 22 5.4 18.6 2 12 2 Z";

// --- Helpers ---
async function phoneFrame(name, x) {
  const f = await cmd("CREATE_FRAME", { parentId: SCREENS_PAGE, name, width: 390, height: 844, x, y: 0, fill: BG });
  await cmd("SET_AUTO_LAYOUT", { id: f.id, layoutMode: "VERTICAL", itemSpacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  return f;
}

async function bottomNav(parentId, activeTab) {
  const nav = await cmd("CREATE_FRAME", { parentId, name: "Bottom Nav", width: 390, height: 70, fill: WHITE, strokeColor: CARD_BORDER, strokeWeight: 1 });
  await cmd("SET_AUTO_LAYOUT", { id: nav.id, layoutMode: "HORIZONTAL", padding: { top: 10, right: 8, bottom: 8, left: 8 }, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "MIN" });
  await cmd("MODIFY_NODE", { id: nav.id, props: { layoutPositioning: "ABSOLUTE" } });
  const tabs = [
    { key: "Home", active: IDS.navHomeActive, inactive: IDS.navHomeInactive },
    { key: "Applications", active: IDS.navAppsActive, inactive: IDS.navAppsInactive },
    { key: "Profile", active: IDS.navProfileActive, inactive: IDS.navProfileInactive },
  ];
  for (const t of tabs) {
    const compId = activeTab === t.key ? t.active : t.inactive;
    const inst = await cmd("CREATE_INSTANCE", { componentId: compId, parentId: nav.id, name: t.key });
    await cmd("MODIFY_NODE", { id: inst.id, props: { layoutSizingHorizontal: "FILL" } });
  }
  const state = await cmd("GET_DOCUMENT_STATE", { id: nav.id, depth: 0 });
  await cmd("MODIFY_NODE", { id: nav.id, props: { x: 0, y: 844 - state.node.height } });
  return nav;
}

async function header(parentId, eyebrow, title, opts = {}) {
  const h = await cmd("CREATE_FRAME", { parentId, name: "Header", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: h.id, layoutMode: "HORIZONTAL", itemSpacing: 12, padding: { top: 16, right: 20, bottom: 16, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: h.id, props: { layoutSizingHorizontal: "FILL" } });
  if (opts.back) {
    const back = await cmd("CREATE_FRAME", { parentId: h.id, name: "Back", width: 32, height: 32, fill: LIGHT_GRAY_BG, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: back.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_VECTOR", { parentId: back.id, name: "Icon", path: CHEVRON_LEFT_PATH, strokeColor: INK, strokeWeight: 2, width: 16, height: 16 });
  }
  const textCol = await cmd("CREATE_FRAME", { parentId: h.id, name: "Text", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: textCol.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: textCol.id, props: { layoutSizingHorizontal: "FILL" } });
  if (eyebrow) await cmd("CREATE_TEXT", { parentId: textCol.id, name: "Eyebrow", content: eyebrow, font: { family: "Inter", style: "Medium" }, fontSize: 13, fill: MUTED });
  await cmd("CREATE_TEXT", { parentId: textCol.id, name: "Title", content: title, font: { family: "Inter", style: "Bold" }, fontSize: 17, fill: INK });
  return h;
}

async function card(parentId, name, opts = {}) {
  const c = await cmd("CREATE_FRAME", { parentId, name, fill: opts.fill || WHITE, cornerRadius: 20, strokeColor: opts.strokeColor || CARD_BORDER, strokeWeight: 1, dropShadow: opts.shadow === false ? undefined : CARD_SHADOW });
  await cmd("SET_AUTO_LAYOUT", { id: c.id, layoutMode: "VERTICAL", itemSpacing: opts.gap ?? 10, padding: opts.padding || { top: 16, right: 16, bottom: 16, left: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: c.id, props: { layoutSizingHorizontal: "FILL" } });
  return c;
}

async function contentCol(parentId) {
  const c = await cmd("CREATE_FRAME", { parentId, name: "Content", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: c.id, layoutMode: "VERTICAL", itemSpacing: 16, padding: { top: 8, right: 20, bottom: 20, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await cmd("MODIFY_NODE", { id: c.id, props: { layoutSizingHorizontal: "FILL" } });
  return c;
}

async function docRow(parentId, label, statusPillId, statusIcon) {
  const row = await cmd("CREATE_FRAME", { parentId, name: `Row/${label}`, fill: WHITE, cornerRadius: 14, strokeColor: CARD_BORDER, strokeWeight: 1 });
  await cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", itemSpacing: 10, padding: { top: 14, right: 14, bottom: 14, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: row.id, props: { layoutSizingHorizontal: "FILL" } });
  const left = await cmd("CREATE_FRAME", { parentId: row.id, name: "Left", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: left.id, layoutMode: "HORIZONTAL", itemSpacing: 10, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  if (statusIcon) {
    const badge = await cmd("CREATE_FRAME", { parentId: left.id, name: "Badge", width: 22, height: 22, fill: statusIcon.bg, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: badge.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_VECTOR", { parentId: badge.id, name: "Icon", path: statusIcon.path, strokeColor: statusIcon.stroke, strokeWeight: 2, width: 12, height: 12 });
  }
  await cmd("CREATE_TEXT", { parentId: left.id, name: "Label", content: label, font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: INK });
  const pillInst = await cmd("CREATE_INSTANCE", { componentId: statusPillId, parentId: row.id, name: "Status" });
  return row;
}

async function chatBubble(parentId, who, text, wide) {
  const row = await cmd("CREATE_FRAME", { parentId, name: who === "ai" ? "AI Message" : "User Message", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: who === "ai" ? "MIN" : "MAX" });
  await cmd("MODIFY_NODE", { id: row.id, props: { layoutSizingHorizontal: "FILL" } });
  if (who === "ai") {
    const avatar = await cmd("CREATE_FRAME", { parentId: row.id, name: "Avatar", width: 24, height: 24, fill: PRIMARY, cornerRadius: 9999 });
    await cmd("SET_AUTO_LAYOUT", { id: avatar.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    await cmd("CREATE_TEXT", { parentId: avatar.id, name: "A", content: "A", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: WHITE });
  }
  const bubble = await cmd("CREATE_FRAME", { parentId: row.id, name: "Bubble", fill: who === "ai" ? WHITE : PRIMARY, cornerRadius: 16, strokeColor: who === "ai" ? CARD_BORDER : undefined, strokeWeight: who === "ai" ? 1 : undefined });
  await cmd("SET_AUTO_LAYOUT", { id: bubble.id, layoutMode: "VERTICAL", padding: { top: 12, right: 14, bottom: 12, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("CREATE_TEXT", { parentId: bubble.id, name: "Text", content: text, font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: who === "ai" ? INK : WHITE, width: 220, lineHeight: 20 });
  return row;
}

async function chip(parentId, label) {
  const c = await cmd("CREATE_FRAME", { parentId, name: `Chip/${label}`, fill: WHITE, cornerRadius: 9999, strokeColor: CARD_BORDER, strokeWeight: 1 });
  await cmd("SET_AUTO_LAYOUT", { id: c.id, layoutMode: "HORIZONTAL", padding: { top: 8, right: 14, bottom: 8, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("CREATE_TEXT", { parentId: c.id, name: "Label", content: label, font: { family: "Inter", style: "Medium" }, fontSize: 13, fill: INK });
  return c;
}

async function summaryRow(parentId, label, value) {
  const r = await cmd("CREATE_FRAME", { parentId, name: `Row/${label}`, fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: r.id, layoutMode: "HORIZONTAL", padding: { top: 10, right: 0, bottom: 10, left: 0 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: r.id, props: { layoutSizingHorizontal: "FILL" } });
  await cmd("CREATE_TEXT", { parentId: r.id, name: "Label", content: label, font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: MUTED });
  await cmd("CREATE_TEXT", { parentId: r.id, name: "Value", content: value, font: { family: "Inter", style: "Medium" }, fontSize: 14, fill: INK });
  return r;
}

async function alertBox(parentId, title, body, kind) {
  const bg = kind === "warning" ? WARNING_BG : SUCCESS_BG;
  const border = kind === "warning" ? WARNING_BORDER : { r: 0.6, g: 0.85, b: 0.7 };
  const a = await cmd("CREATE_FRAME", { parentId, name: "Alert", fill: bg, cornerRadius: 14, strokeColor: border, strokeWeight: 1 });
  await cmd("SET_AUTO_LAYOUT", { id: a.id, layoutMode: "VERTICAL", itemSpacing: 4, padding: { top: 14, right: 14, bottom: 14, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await cmd("MODIFY_NODE", { id: a.id, props: { layoutSizingHorizontal: "FILL" } });
  await cmd("CREATE_TEXT", { parentId: a.id, name: "Title", content: title, font: { family: "Inter", style: "Bold" }, fontSize: 14, fill: kind === "warning" ? AMBER_TEXT : SUCCESS_TEXT });
  if (body) await cmd("CREATE_TEXT", { parentId: a.id, name: "Body", content: body, font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: INK, width: 320 });
  return a;
}

async function primaryBtnInstance(parentId, label, full) {
  const inst = await cmd("CREATE_INSTANCE", { componentId: IDS.btnPrimary, parentId, name: label });
  const l = findChild(inst, "Label");
  await cmd("MODIFY_NODE", { id: l.id, props: { characters: label } });
  if (full) await cmd("MODIFY_NODE", { id: inst.id, props: { layoutSizingHorizontal: "FILL" } });
  return inst;
}
async function secondaryBtnInstance(parentId, label, full) {
  const inst = await cmd("CREATE_INSTANCE", { componentId: IDS.btnSecondary, parentId, name: label });
  const l = findChild(inst, "Label");
  await cmd("MODIFY_NODE", { id: l.id, props: { characters: label } });
  if (full) await cmd("MODIFY_NODE", { id: inst.id, props: { layoutSizingHorizontal: "FILL" } });
  return inst;
}

export {
  cmd, findChild, phoneFrame, bottomNav, header, card, contentCol, docRow, chatBubble, chip,
  summaryRow, alertBox, primaryBtnInstance, secondaryBtnInstance,
  BG, INK, MUTED, PRIMARY, WARNING_BG, WARNING_BORDER, AMBER_TEXT, SUCCESS_BG, SUCCESS_TEXT,
  WHITE, TRANSPARENT, CARD_BORDER, LIGHT_GRAY_BG, IDS, CHECK_PATH, WARNING_PATH, CIRCLE_PATH,
};
