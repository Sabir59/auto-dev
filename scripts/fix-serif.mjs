const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const HEADLINES = ["14006:267", "14006:399", "14006:432", "14006:458", "14006:491", "14006:518", "14006:532", "14006:626", "14006:576", "14006:624"];

async function main() {
  for (const id of HEADLINES) {
    await cmd("MODIFY_NODE", { id, props: { font: { family: "Georgia", style: "Bold" } } });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
