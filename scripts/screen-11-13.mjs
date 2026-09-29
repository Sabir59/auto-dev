import * as V from "./visa-screens.mjs";

async function appCard(parentId, title, statusText, statusPillId, actionLabel, needsAttention) {
  const c = await V.card(parentId, `AppCard/${title}`, { gap: 4, fill: needsAttention ? V.WARNING_BG : V.WHITE, strokeColor: needsAttention ? V.WARNING_BORDER : V.CARD_BORDER });
  const row = await V.cmd("CREATE_FRAME", { parentId: c.id, name: "Title Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: row.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: row.id, name: "Title", content: title, font: { family: "Inter", style: "Bold" }, fontSize: 15, fill: V.INK });
  if (statusPillId) await V.cmd("CREATE_INSTANCE", { componentId: statusPillId, parentId: row.id, name: "Status" });
  const row2 = await V.cmd("CREATE_FRAME", { parentId: c.id, name: "Sub Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: row2.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: row2.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: row2.id, name: "Status Text", content: statusText, font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: needsAttention ? V.AMBER_TEXT : V.MUTED });
  await V.cmd("CREATE_TEXT", { parentId: row2.id, name: "Action", content: actionLabel + " →", font: { family: "Inter", style: "Medium" }, fontSize: 13, fill: V.PRIMARY });
  return c;
}

async function screen11Hub() {
  const s = await V.phoneFrame("11 Applications Hub", 5100);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  const topRow = await V.cmd("CREATE_FRAME", { parentId: s.id, name: "Top Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: topRow.id, layoutMode: "HORIZONTAL", padding: { top: 20, right: 20, bottom: 12, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: topRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: topRow.id, name: "Title", content: "Applications", font: { family: "Inter", style: "Bold" }, fontSize: 24, fill: V.INK });
  await V.primaryBtnInstance(topRow.id, "+ New");

  const content = await V.contentCol(s.id);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Needs Attention Label", content: "NEEDS ATTENTION", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await appCard(content.id, "Brazilian Tourist Visa", "Flight itinerary missing", null, "Fix", true);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "All Label", content: "ALL APPLICATIONS", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await appCard(content.id, "Brazilian Tourist Visa", "Waiting for 1 document", V.IDS.pillInProgress, "Continue", false);
  await appCard(content.id, "Canadian Visitor Visa", "Under review", V.IDS.pillSubmitted, "Track", false);
  await appCard(content.id, "Schengen Visa (France)", "Approved · Oct 2025", V.IDS.pillCompleted, "View", false);

  await V.bottomNav(s.id, "Applications");
  console.log("11 Hub:", s.id);
}

async function screen11bEmpty() {
  const s = await V.phoneFrame("11b Applications Hub - Empty", 5650);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  const topRow = await V.cmd("CREATE_FRAME", { parentId: s.id, name: "Top Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: topRow.id, layoutMode: "HORIZONTAL", padding: { top: 20, right: 20, bottom: 12, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: topRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: topRow.id, name: "Title", content: "Applications", font: { family: "Inter", style: "Bold" }, fontSize: 24, fill: V.INK });

  const content = await V.contentCol(s.id);
  await V.cmd("MODIFY_NODE", { id: content.id, props: { layoutSizingVertical: "FILL" } });
  await V.cmd("SET_AUTO_LAYOUT", { id: content.id, layoutMode: "VERTICAL", itemSpacing: 12, padding: { top: 60, right: 20, bottom: 20, left: 20 }, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "No applications yet", font: { family: "Inter", style: "Bold" }, fontSize: 18, fill: V.INK });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "Tell me what you're trying to do and I'll take it from there.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 260, lineHeight: 20 });
  await V.cmd("MODIFY_NODE", { id: content.id, props: { counterAxisAlignItems: "CENTER" } });
  await V.primaryBtnInstance(content.id, "Start a new application");

  await V.bottomNav(s.id, "Applications");
  console.log("11b Empty:", s.id);
}

async function screen12Details() {
  const s = await V.phoneFrame("12 Details - Edit", 6200);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Your details", { back: true });
  const content = await V.contentCol(s.id);

  async function section(title, rows, expanded) {
    const c = await V.card(content.id, `Section/${title}`, { gap: 2 });
    await V.cmd("CREATE_TEXT", { parentId: c.id, name: "Title", content: title, font: { family: "Inter", style: "Bold" }, fontSize: 15, fill: V.INK });
    if (expanded) {
      for (const [label, value] of rows) await V.summaryRow(c.id, label, value);
    }
  }
  await section("Applicant", [["Full name", "Ahmad Khan"], ["Nationality", "Afghan"], ["Date of birth", "14 Mar 1987"], ["Passport number", "•••• 4821"], ["Passport expiry", "19 Jun 2031"]], true);
  await section("Travel", [["Purpose", "Tourism"], ["Arrival date", "12 Oct 2024"], ["Departure date", "26 Oct 2024"], ["Port of entry", "São Paulo–Guarulhos"]], true);
  await section("Accommodation", [], false);
  await section("Employment", [], false);

  console.log("12 Details:", s.id);
}

async function screen13Profile() {
  const s = await V.phoneFrame("13 Profile", 6800);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, null, "Profile", {});
  const content = await V.contentCol(s.id);
  const card = await V.card(content.id, "User Card", { gap: 2 });
  await V.cmd("CREATE_TEXT", { parentId: card.id, name: "Name", content: "Ahmad Khan", font: { family: "Inter", style: "Bold" }, fontSize: 16, fill: V.INK });
  await V.cmd("CREATE_TEXT", { parentId: card.id, name: "Email", content: "ahmad.khan@example.com", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED });
  await V.secondaryBtnInstance(content.id, "Sign out", true);
  await V.bottomNav(s.id, "Profile");
  console.log("13 Profile:", s.id);
}

await screen11Hub();
await screen11bEmpty();
await screen12Details();
await screen13Profile();
