const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const CARD_IDS = [
  "14006:401", "14006:434", "14006:345", "14006:409", "14006:442", "14006:567",
  "14006:534", "14006:385", "14006:493", "14006:460", "14006:405", "14006:438",
  "14006:688", "14006:328", "14006:368", "14006:187", "14006:180", "14006:581",
  "14006:588", "14006:596", "14006:604", "14006:648", "14006:665", "14006:679", "14006:681",
];

async function main() {
  for (const id of CARD_IDS) {
    await cmd("MODIFY_NODE", { id, props: { dropShadow: null } });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
