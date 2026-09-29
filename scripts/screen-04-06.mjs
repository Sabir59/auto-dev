import * as V from "./visa-screens.mjs";

async function passportCard(parentId) {
  const c = await V.card(parentId, "Passport Card", { gap: 8 });
  const row = await V.cmd("CREATE_FRAME", { parentId: c.id, name: "Title Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: row.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: row.id, name: "Title", content: "Passport", font: { family: "Inter", style: "Bold" }, fontSize: 16, fill: V.INK });
  await V.cmd("CREATE_INSTANCE", { componentId: V.IDS.pillVerified, parentId: row.id, name: "Status" });
  for (const item of ["Name detected", "Passport number detected", "Date of birth detected", "Expiry date detected"]) {
    const r = await V.cmd("CREATE_FRAME", { parentId: c.id, name: `Item/${item}`, fill: V.TRANSPARENT });
    await V.cmd("SET_AUTO_LAYOUT", { id: r.id, layoutMode: "HORIZONTAL", itemSpacing: 6, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
    await V.cmd("CREATE_VECTOR", { parentId: r.id, name: "Check", path: V.CHECK_PATH, strokeColor: V.SUCCESS_TEXT, strokeWeight: 2, width: 14, height: 14 });
    await V.cmd("CREATE_TEXT", { parentId: r.id, name: "Label", content: item, font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED });
  }
  return c;
}

async function screen04aConflict() {
  const s = await V.phoneFrame("04a Validation - Conflict", 1350);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Checking your documents", { back: true });
  const content = await V.contentCol(s.id);
  await passportCard(content.id);

  const alert = await V.card(content.id, "Conflict Alert", { fill: V.WARNING_BG, strokeColor: V.WARNING_BORDER, gap: 10 });
  await V.cmd("CREATE_TEXT", { parentId: alert.id, name: "Title", content: "⚠ Something needs your attention", font: { family: "Inter", style: "Bold" }, fontSize: 14, fill: V.AMBER_TEXT });
  await V.cmd("CREATE_TEXT", { parentId: alert.id, name: "Body", content: "The name on your accommodation document looks different from your passport.", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.INK, width: 320 });
  const compareRow = await V.cmd("CREATE_FRAME", { parentId: alert.id, name: "Compare", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: compareRow.id, layoutMode: "HORIZONTAL", itemSpacing: 10, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await V.cmd("MODIFY_NODE", { id: compareRow.id, props: { layoutSizingHorizontal: "FILL" } });
  for (const [label, value] of [["Passport", "Ahmad Khan"], ["Accommodation", "Ahmed Khan"]]) {
    const box = await V.cmd("CREATE_FRAME", { parentId: compareRow.id, name: label, fill: { r: 1, g: 1, b: 1, a: 0.5 }, cornerRadius: 10 });
    await V.cmd("SET_AUTO_LAYOUT", { id: box.id, layoutMode: "VERTICAL", itemSpacing: 2, padding: { top: 10, right: 12, bottom: 10, left: 12 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
    await V.cmd("MODIFY_NODE", { id: box.id, props: { layoutSizingHorizontal: "FILL" } });
    await V.cmd("CREATE_TEXT", { parentId: box.id, name: "Label", content: label, font: { family: "Inter", style: "Regular" }, fontSize: 12, fill: V.AMBER_TEXT });
    await V.cmd("CREATE_TEXT", { parentId: box.id, name: "Value", content: value, font: { family: "Inter", style: "Medium" }, fontSize: 14, fill: V.INK });
  }
  const btnRow = await V.cmd("CREATE_FRAME", { parentId: alert.id, name: "Buttons", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: btnRow.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await V.cmd("MODIFY_NODE", { id: btnRow.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.primaryBtnInstance(btnRow.id, "Fix this", true);
  await V.secondaryBtnInstance(btnRow.id, "Keep as is", true);

  console.log("04a Validation Conflict:", s.id);
  return s;
}

async function screen04bResolved() {
  const s = await V.phoneFrame("04b Validation - Resolved", 1800);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Checking your documents", { back: true });
  const content = await V.contentCol(s.id);
  await passportCard(content.id);
  const resolved = await V.card(content.id, "Resolved", { fill: V.SUCCESS_BG, strokeColor: { r: 0.6, g: 0.85, b: 0.7 }, gap: 4 });
  await V.cmd("CREATE_TEXT", { parentId: resolved.id, name: "Title", content: "✓ Accommodation document", font: { family: "Inter", style: "Bold" }, fontSize: 14, fill: V.SUCCESS_TEXT });
  await V.cmd("CREATE_TEXT", { parentId: resolved.id, name: "Body", content: "Name discrepancy noted and resolved.", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.INK });
  await V.primaryBtnInstance(content.id, "Continue — application ready", true);
  console.log("04b Validation Resolved:", s.id);
  return s;
}

async function screen05Summary(ready) {
  const s = await V.phoneFrame(ready ? "05b Summary - Ready" : "05a Summary - Attention", ready ? 2250 : 1900);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Application status", { back: true });
  const content = await V.contentCol(s.id);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Eyebrow", content: ready ? "READY" : "ALMOST THERE", font: { family: "Inter", style: "Bold" }, fontSize: 12, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: ready ? "Your application is ready to review." : "A couple of things need your input.", font: { family: "Inter", style: "Bold" }, fontSize: 22, fill: V.INK, width: 340, lineHeight: 28 });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "I've prepared everything from your documents and answers.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 340 });

  const applicant = await V.card(content.id, "Applicant Card", { gap: 2 });
  await V.cmd("CREATE_TEXT", { parentId: applicant.id, name: "Label", content: "APPLICANT", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await V.cmd("CREATE_TEXT", { parentId: applicant.id, name: "Value", content: "Ahmad Khan", font: { family: "Inter", style: "Bold" }, fontSize: 16, fill: V.INK });
  await V.cmd("CREATE_TEXT", { parentId: applicant.id, name: "Sub", content: "Afghan · Passport •••• 4821", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED });

  const travel = await V.card(content.id, "Travel Card", { gap: 2 });
  await V.cmd("CREATE_TEXT", { parentId: travel.id, name: "Label", content: "TRAVEL", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  await V.cmd("CREATE_TEXT", { parentId: travel.id, name: "Value", content: "Brazil", font: { family: "Inter", style: "Bold" }, fontSize: 16, fill: V.INK });
  await V.cmd("CREATE_TEXT", { parentId: travel.id, name: "Sub", content: "Tourism · 12 Oct – 26 Oct", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED });

  const docsCard = await V.card(content.id, "Documents Card", { gap: 2 });
  const dr = await V.cmd("CREATE_FRAME", { parentId: docsCard.id, name: "Row", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: dr.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_TEXT", { parentId: dr.id, name: "Label", content: "DOCUMENTS", font: { family: "Inter", style: "Bold" }, fontSize: 11, fill: V.MUTED, letterSpacing: { unit: "PIXELS", value: 1 } });
  const dr2 = await V.cmd("CREATE_FRAME", { parentId: docsCard.id, name: "Row2", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: dr2.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_TEXT", { parentId: dr2.id, name: "Count", content: "5 documents", font: { family: "Inter", style: "Medium" }, fontSize: 14, fill: V.INK });
  if (ready) await V.cmd("CREATE_TEXT", { parentId: dr2.id, name: "Check", content: "✓ Complete", font: { family: "Inter", style: "Medium" }, fontSize: 13, fill: V.SUCCESS_TEXT });

  if (!ready) {
    await V.alertBox(content.id, "2 things need your attention", null, "warning");
    for (const item of ["Travel accommodation needs confirmation", "Please confirm your intended arrival date"]) {
      await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Item", content: "⚠ " + item, font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.AMBER_TEXT, width: 330 });
    }
    const btnRow = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Buttons", fill: V.TRANSPARENT });
    await V.cmd("SET_AUTO_LAYOUT", { id: btnRow.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
    await V.cmd("MODIFY_NODE", { id: btnRow.id, props: { layoutSizingHorizontal: "FILL" } });
    await V.secondaryBtnInstance(btnRow.id, "Edit details", true);
    await V.primaryBtnInstance(btnRow.id, "Review", true);
  } else {
    await V.primaryBtnInstance(content.id, "Review & Confirm", true);
  }

  console.log((ready ? "05b" : "05a"), s.id);
  return s;
}

await screen04aConflict();
await screen04bResolved();
await screen05Summary(false);
await screen05Summary(true);
