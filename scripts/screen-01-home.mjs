import * as V from "./visa-screens.mjs";

async function main() {
  const screen = await V.phoneFrame("01 Home", 0);
  await V.cmd("SET_AUTO_LAYOUT", { id: screen.id, layoutMode: "VERTICAL", itemSpacing: 20, padding: { top: 24, right: 20, bottom: 24, left: 20 }, primaryAxisAlignItems: "MIN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });

  await V.cmd("CREATE_TEXT", { parentId: screen.id, name: "Headline", content: "What do you need help with?", font: { family: "Inter", style: "Bold" }, fontSize: 26, fill: V.INK, width: 350, lineHeight: 32 });
  await V.cmd("CREATE_TEXT", { parentId: screen.id, name: "Subtext", content: "Tell me in plain language — I'll handle the rest.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 350 });

  // Input card
  const inputCard = await V.card(screen.id, "Input Card", { gap: 14 });
  await V.cmd("CREATE_TEXT", { parentId: inputCard.id, name: "Placeholder", content: "I need to apply for a Brazilian tourist visa…", font: { family: "Inter", style: "Regular" }, fontSize: 15, fill: { r: 0.7, g: 0.7, b: 0.7 }, width: 320 });
  const row = await V.cmd("CREATE_FRAME", { parentId: inputCard.id, name: "Actions Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: row.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.secondaryBtnInstance(row.id, "Speak");
  await V.primaryBtnInstance(row.id, "Send");

  // Active application card
  const appCard = await V.card(screen.id, "Active Application", { gap: 6 });
  await V.cmd("CREATE_TEXT", { parentId: appCard.id, name: "Eyebrow", content: "ACTIVE APPLICATION", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await V.cmd("CREATE_TEXT", { parentId: appCard.id, name: "Title", content: "Brazilian Tourist Visa", font: { family: "Inter", style: "Bold" }, fontSize: 17, fill: V.INK });
  const statusRow = await V.cmd("CREATE_FRAME", { parentId: appCard.id, name: "Status Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: statusRow.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: statusRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: statusRow.id, name: "Status", content: "Waiting for 1 document", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.AMBER_TEXT });
  await V.primaryBtnInstance(statusRow.id, "Continue");

  await V.bottomNav(screen.id, "Home");
  console.log("Screen 01 Home:", screen.id);
}
main().catch((e) => { console.error(e); process.exit(1); });
