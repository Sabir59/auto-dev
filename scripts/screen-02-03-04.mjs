import * as V from "./visa-screens.mjs";

async function screen02Chat() {
  const s = await V.phoneFrame("02 AI Chat", 450);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisAlignItems: "SPACE_BETWEEN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "AI Assistant", { back: true });

  const scroll = await V.cmd("CREATE_FRAME", { parentId: s.id, name: "Transcript", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: scroll.id, layoutMode: "VERTICAL", itemSpacing: 12, padding: { top: 8, right: 20, bottom: 20, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.cmd("MODIFY_NODE", { id: scroll.id, props: { layoutSizingHorizontal: "FILL" } });

  await V.chatBubble(scroll.id, "ai", "Absolutely — I'll help you prepare your Brazilian tourist visa application.");
  await V.chatBubble(scroll.id, "ai", "I'll figure out exactly what's needed and only ask you for things I can't work out myself.");
  await V.chatBubble(scroll.id, "ai", "First — where are you currently applying from?");
  const chips = await V.cmd("CREATE_FRAME", { parentId: scroll.id, name: "Quick Replies", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: chips.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  for (const c of ["United Kingdom", "United States", "Germany", "Other"]) await V.chip(chips.id, c);

  const inputBar = await V.cmd("CREATE_FRAME", { parentId: s.id, name: "Input Bar", fill: V.WHITE, strokeColor: V.CARD_BORDER, strokeWeight: 1 });
  await V.cmd("SET_AUTO_LAYOUT", { id: inputBar.id, layoutMode: "HORIZONTAL", itemSpacing: 10, padding: { top: 12, right: 16, bottom: 12, left: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: inputBar.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: inputBar.id, name: "Placeholder", content: "Reply…", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: { r: 0.7, g: 0.7, b: 0.7 } });
  await V.cmd("CREATE_FRAME", { parentId: inputBar.id, name: "Send", width: 32, height: 32, fill: V.PRIMARY, cornerRadius: 9999 });

  await V.bottomNav(s.id, "Applications");
  console.log("02 AI Chat:", s.id);
}

async function screen03Documents() {
  const s = await V.phoneFrame("03 Documents", 900);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Documents", { back: true });
  const content = await V.contentCol(s.id);

  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "I'll extract everything automatically.", font: { family: "Inter", style: "Bold" }, fontSize: 20, fill: V.INK, width: 340, lineHeight: 26 });

  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Required Label", content: "REQUIRED", font: { family: "Inter", style: "Bold" }, fontSize: 12, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  const reqCol = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Required Rows", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: reqCol.id, layoutMode: "VERTICAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.cmd("MODIFY_NODE", { id: reqCol.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.docRow(reqCol.id, "Passport", V.IDS.pillUploaded, { path: V.CHECK_PATH, bg: V.PRIMARY, stroke: V.WHITE });
  await V.docRow(reqCol.id, "Passport photo", V.IDS.pillUploaded, { path: V.CHECK_PATH, bg: V.PRIMARY, stroke: V.WHITE });
  await V.docRow(reqCol.id, "Proof of accommodation", V.IDS.pillNeedsReview, { path: V.WARNING_PATH, bg: V.WARNING_BG, stroke: V.AMBER_TEXT });
  // Not-yet-uploaded row needs an action button, not a status pill — built
  // directly rather than forcing it through the docRow(pill) shape.
  const flightRow = await V.cmd("CREATE_FRAME", { parentId: reqCol.id, name: "Row/Flight itinerary", fill: V.WHITE, cornerRadius: 14, strokeColor: V.CARD_BORDER, strokeWeight: 1 });
  await V.cmd("SET_AUTO_LAYOUT", { id: flightRow.id, layoutMode: "HORIZONTAL", itemSpacing: 10, padding: { top: 14, right: 14, bottom: 14, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: flightRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: flightRow.id, name: "Label", content: "Flight itinerary", font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: V.INK });
  await V.secondaryBtnInstance(flightRow.id, "Upload");

  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Supporting Label", content: "SUPPORTING", font: { family: "Inter", style: "Bold" }, fontSize: 12, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  const supCol = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Supporting Rows", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: supCol.id, layoutMode: "VERTICAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.cmd("MODIFY_NODE", { id: supCol.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.docRow(supCol.id, "Bank statement", V.IDS.pillUploaded, { path: V.CHECK_PATH, bg: V.PRIMARY, stroke: V.WHITE });

  const empRow = await V.cmd("CREATE_FRAME", { parentId: supCol.id, name: "Row/Employment letter", fill: V.WHITE, cornerRadius: 14, strokeColor: V.CARD_BORDER, strokeWeight: 1 });
  await V.cmd("SET_AUTO_LAYOUT", { id: empRow.id, layoutMode: "HORIZONTAL", itemSpacing: 10, padding: { top: 14, right: 14, bottom: 14, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: empRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: empRow.id, name: "Label", content: "Employment letter", font: { family: "Inter", style: "Medium" }, fontSize: 15, fill: V.MUTED });
  const empRight = await V.cmd("CREATE_FRAME", { parentId: empRow.id, name: "Right", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: empRight.id, layoutMode: "HORIZONTAL", itemSpacing: 10, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_TEXT", { parentId: empRight.id, name: "Optional", content: "Optional", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED });
  await V.secondaryBtnInstance(empRight.id, "Upload");

  await V.bottomNav(s.id, "Applications");
  console.log("03 Documents:", s.id);
  return { reqCol };
}

const chat = await screen02Chat();
const docs = await screen03Documents();
console.log("Note: 'Flight itinerary' row needs a manual upload-button fix pass.");
