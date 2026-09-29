const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

// Left-to-right journey order, uniform 500px spacing (frames are 390 wide,
// leaving a clean 110px gap regardless of any individual screen's height).
const ORDER = [
  "14006:177", // 01 Home
  "14006:214", // 02 AI Chat
  "14006:259", // 03 Documents
  "14006:320", // 04a Validation - Conflict
  "14006:360", // 04b Validation - Resolved
  "14006:390", // 05a Summary - Attention
  "14006:423", // 05b Summary - Ready
  "14006:450", // 06 Review & Confirm
  "14006:485", // 07 Submitting
  "14006:510", // 08 Human Action Needed
  "14006:525", // 09 Submitted
  "14006:559", // 10 Error
  "14006:574", // 11 Applications Hub
  "14006:622", // 11b Applications Hub - Empty
  "14006:640", // 12 Details - Edit
  "14006:683", // 13 Profile
];

async function main() {
  for (let i = 0; i < ORDER.length; i++) {
    await cmd("MODIFY_NODE", { id: ORDER[i], props: { x: i * 500, y: 0 } });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
