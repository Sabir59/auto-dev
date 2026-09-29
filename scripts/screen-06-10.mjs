import * as V from "./visa-screens.mjs";

async function screen06Review() {
  const s = await V.phoneFrame("06 Review & Confirm", 2650);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Review", { back: true });
  const content = await V.contentCol(s.id);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "Everything look correct?", font: { family: "Inter", style: "Bold" }, fontSize: 22, fill: V.INK, width: 340, lineHeight: 28 });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "You're confirming what I've prepared — not filling it out yourself.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 340 });

  const table = await V.card(content.id, "Summary Table", { gap: 0 });
  await V.summaryRow(table.id, "Application", "Brazil Tourist Visa");
  await V.summaryRow(table.id, "Applicant", "Ahmad Khan");
  await V.summaryRow(table.id, "Nationality", "Afghan");
  await V.summaryRow(table.id, "Purpose", "Tourism");
  await V.summaryRow(table.id, "Travel dates", "12 Oct – 26 Oct 2024");
  await V.summaryRow(table.id, "Documents", "5 attached");

  const noteBox = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Next Step Note", fill: { r: 0.9137, g: 0.9255, b: 0.9922 }, cornerRadius: 12 });
  await V.cmd("SET_AUTO_LAYOUT", { id: noteBox.id, layoutMode: "VERTICAL", padding: { top: 12, right: 14, bottom: 12, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  await V.cmd("MODIFY_NODE", { id: noteBox.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: noteBox.id, name: "Note", content: "Next: I'll submit this directly on the official Brazilian visa portal on your behalf.", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.PRIMARY, width: 320 });

  await V.primaryBtnInstance(content.id, "Confirm & Submit Application", true);
  await V.secondaryBtnInstance(content.id, "Edit", true);
  console.log("06 Review:", s.id);
}

async function screen07Submitting() {
  const s = await V.phoneFrame("07 Submitting", 3100);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Submitting", { back: false });
  const content = await V.contentCol(s.id);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "Submitting your application.", font: { family: "Inter", style: "Bold" }, fontSize: 22, fill: V.INK, width: 340, lineHeight: 28 });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "I'm working on the official Brazilian visa portal right now. This usually takes a few minutes — you don't need to do anything yet.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 340 });

  const steps = await V.card(content.id, "Steps", { gap: 14 });
  const stepList = [
    ["Logging in to the visa portal", "done"],
    ["Filling in your application", "done"],
    ["Uploading your documents", "active"],
    ["Awaiting portal confirmation", "pending"],
  ];
  for (const [label, state] of stepList) {
    const row = await V.cmd("CREATE_FRAME", { parentId: steps.id, name: label, fill: V.TRANSPARENT });
    await V.cmd("SET_AUTO_LAYOUT", { id: row.id, layoutMode: "HORIZONTAL", itemSpacing: 10, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
    const dotColor = state === "done" ? V.SUCCESS_TEXT : state === "active" ? V.PRIMARY : { r: 0.8, g: 0.8, b: 0.8 };
    const dot = await V.cmd("CREATE_FRAME", { parentId: row.id, name: "Dot", width: 20, height: 20, fill: state === "pending" ? V.TRANSPARENT : dotColor, cornerRadius: 9999, strokeColor: state === "pending" ? { r: 0.8, g: 0.8, b: 0.8 } : undefined, strokeWeight: state === "pending" ? 2 : undefined });
    await V.cmd("SET_AUTO_LAYOUT", { id: dot.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
    if (state === "done") await V.cmd("CREATE_VECTOR", { parentId: dot.id, name: "Check", path: V.CHECK_PATH, strokeColor: V.WHITE, strokeWeight: 2, width: 10, height: 10 });
    await V.cmd("CREATE_TEXT", { parentId: row.id, name: "Label", content: label, font: { family: "Inter", style: state === "active" ? "Bold" : "Regular" }, fontSize: 14, fill: state === "pending" ? V.MUTED : V.INK });
  }

  const waitNote = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Wait Note", fill: V.TRANSPARENT });
  await V.cmd("SET_AUTO_LAYOUT", { id: waitNote.id, layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_TEXT", { parentId: waitNote.id, name: "Label", content: "You can leave this screen — I'll notify you if I need anything.", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.MUTED, width: 320 });
  console.log("07 Submitting:", s.id);
}

async function screen08OTP() {
  const s = await V.phoneFrame("08 Human Action Needed", 3600);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Action needed", { back: false });
  const content = await V.contentCol(s.id);

  const banner = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Banner", fill: { r: 0.9137, g: 0.9255, b: 0.9922 }, cornerRadius: 14 });
  await V.cmd("SET_AUTO_LAYOUT", { id: banner.id, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: { top: 10, right: 14, bottom: 10, left: 14 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: banner.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: banner.id, name: "Label", content: "This step can only be done by you", font: { family: "Inter", style: "Bold" }, fontSize: 12, fill: V.PRIMARY });

  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "The visa portal needs to verify it's you.", font: { family: "Inter", style: "Bold" }, fontSize: 21, fill: V.INK, width: 340, lineHeight: 27 });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "Brazil's official portal sent a one-time code to your phone ending in •••• 4821. Enter it below to continue — I'll take it from there.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 340 });

  const otpBox = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "OTP Field", fill: V.WHITE, cornerRadius: 14, strokeColor: V.CARD_BORDER, strokeWeight: 1 });
  await V.cmd("SET_AUTO_LAYOUT", { id: otpBox.id, layoutMode: "HORIZONTAL", padding: { top: 16, right: 16, bottom: 16, left: 16 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "CENTER" });
  await V.cmd("MODIFY_NODE", { id: otpBox.id, props: { layoutSizingHorizontal: "FILL" } });
  await V.cmd("CREATE_TEXT", { parentId: otpBox.id, name: "Placeholder", content: "• • • • • •", font: { family: "Inter", style: "Bold" }, fontSize: 22, fill: V.INK, letterSpacing: { unit: "PIXELS", value: 4 } });

  await V.primaryBtnInstance(content.id, "Verify & Continue", true);
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Resend", content: "Didn't get a code? Resend", font: { family: "Inter", style: "Medium" }, fontSize: 13, fill: V.PRIMARY });
  console.log("08 OTP:", s.id);
}

async function screen09Submitted() {
  const s = await V.phoneFrame("09 Submitted", 4100);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisAlignItems: "SPACE_BETWEEN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, null, "Submitted", { back: false });
  const content = await V.contentCol(s.id);

  const badge = await V.cmd("CREATE_FRAME", { parentId: content.id, name: "Badge", width: 72, height: 72, fill: V.SUCCESS_BG, cornerRadius: 9999 });
  await V.cmd("SET_AUTO_LAYOUT", { id: badge.id, layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" });
  await V.cmd("CREATE_VECTOR", { parentId: badge.id, name: "Check", path: V.CHECK_PATH, strokeColor: V.SUCCESS_TEXT, strokeWeight: 3, width: 32, height: 32 });

  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Headline", content: "Your application has been submitted.", font: { family: "Inter", style: "Bold" }, fontSize: 22, fill: V.INK, width: 340, lineHeight: 28 });
  await V.cmd("CREATE_TEXT", { parentId: content.id, name: "Subtext", content: "Brazil's official visa portal has received it and is now reviewing your case.", font: { family: "Inter", style: "Regular" }, fontSize: 14, fill: V.MUTED, width: 340 });

  const receipt = await V.card(content.id, "Receipt", { gap: 0 });
  await V.summaryRow(receipt.id, "Confirmation number", "BR-VT-88214");
  await V.summaryRow(receipt.id, "Submitted", "29 Sep 2026, 14:02");
  await V.summaryRow(receipt.id, "Portal", "gov.br/visas");
  await V.summaryRow(receipt.id, "Expected response", "5–10 business days");

  await V.primaryBtnInstance(content.id, "Track this application", true);
  await V.bottomNav(s.id, "Applications");
  console.log("09 Submitted:", s.id);
}

async function screen10Error() {
  const s = await V.phoneFrame("10 Error", 4600);
  await V.cmd("SET_AUTO_LAYOUT", { id: s.id, layoutMode: "VERTICAL", itemSpacing: 0, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" });
  await V.header(s.id, "Brazilian Tourist Visa", "Something went wrong", { back: true });
  const content = await V.contentCol(s.id);
  const alert = await V.card(content.id, "Error", { fill: { r: 0.9922, g: 0.9098, b: 0.898 }, strokeColor: { r: 0.9176, g: 0.6, b: 0.5333 }, gap: 8 });
  await V.cmd("CREATE_TEXT", { parentId: alert.id, name: "Title", content: "⚠ The visa portal didn't respond", font: { family: "Inter", style: "Bold" }, fontSize: 15, fill: { r: 0.7, g: 0.2, b: 0.15 } });
  await V.cmd("CREATE_TEXT", { parentId: alert.id, name: "Body", content: "This sometimes happens on government sites during busy periods. Your information hasn't been lost — nothing has been submitted yet.", font: { family: "Inter", style: "Regular" }, fontSize: 13, fill: V.INK, width: 320 });
  await V.primaryBtnInstance(content.id, "Try again", true);
  await V.secondaryBtnInstance(content.id, "Contact support", true);
  console.log("10 Error:", s.id);
}

await screen06Review();
await screen07Submitting();
await screen08OTP();
await screen09Submitted();
await screen10Error();
