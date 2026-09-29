const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

// Warm neutral matching the CARD_BORDER/BG family, replacing the
// mismatched cool pure-gray (#E6E6E6) that was used for Back buttons and
// the Secondary button.
const WARM_NEUTRAL = { r: 0.9333, g: 0.9294, b: 0.9137 };

const BACK_BUTTONS = ["14006:216", "14006:261", "14006:322", "14006:362", "14006:392", "14006:425", "14006:452", "14006:561", "14006:642"];

async function main() {
  for (const id of BACK_BUTTONS) {
    await cmd("MODIFY_NODE", { id, props: { fill: WARM_NEUTRAL } });
  }
  // Secondary button component — fixes every instance at once.
  await cmd("MODIFY_NODE", { id: "14006:130", props: { fill: WARM_NEUTRAL } });
}
main().catch((e) => { console.error(e); process.exit(1); });
