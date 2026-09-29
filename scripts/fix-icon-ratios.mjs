const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const CHEVRONS = ["14006:217", "14006:262", "14006:323", "14006:363", "14006:393", "14006:426", "14006:453", "14006:562", "14006:643"];

async function main() {
  for (const id of CHEVRONS) {
    await cmd("MODIFY_NODE", { id, props: { width: 7, height: 14 } });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
