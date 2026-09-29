const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const INK = { r: 0.0941, g: 0.0941, b: 0.102 };
const TRANSPARENT = { r: 1, g: 1, b: 1, a: 0 };

const SCREENS = [
  "14006:177", "14006:214", "14006:259", "14006:320", "14006:360", "14006:390",
  "14006:423", "14006:450", "14006:485", "14006:510", "14006:525", "14006:559",
  "14006:574", "14006:622", "14006:640", "14006:683",
];

async function addStatusBar(screenId) {
  const bar = await cmd("CREATE_FRAME", { parentId: screenId, name: "Status Bar", fill: TRANSPARENT, insertIndex: 0 });
  await cmd("SET_AUTO_LAYOUT", { id: bar.id, layoutMode: "HORIZONTAL", padding: { top: 10, right: 20, bottom: 14, left: 20 }, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER" });
  await cmd("MODIFY_NODE", { id: bar.id, props: { layoutSizingHorizontal: "FILL" } });

  await cmd("CREATE_TEXT", { parentId: bar.id, name: "Time", content: "9:41", font: { family: "Inter", style: "Medium" }, fontSize: 14, fill: INK });

  const cluster = await cmd("CREATE_FRAME", { parentId: bar.id, name: "System", fill: TRANSPARENT });
  await cmd("SET_AUTO_LAYOUT", { id: cluster.id, layoutMode: "HORIZONTAL", itemSpacing: 5, primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", counterAxisAlignItems: "MAX" });

  const barHeights = [5, 7, 9, 11];
  for (const h of barHeights) {
    const b = await cmd("CREATE_FRAME", { parentId: cluster.id, name: "Bar", width: 3, height: h, fill: INK, cornerRadius: 1 });
  }
  await cmd("CREATE_FRAME", { parentId: cluster.id, name: "Battery", width: 22, height: 11, fill: INK, cornerRadius: 3 });
}

async function main() {
  for (const id of SCREENS) await addStatusBar(id);
}
main().catch((e) => { console.error(e); process.exit(1); });
