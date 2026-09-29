// Replace hand-built NavTab icons with real Lucide-derived paths (house,
// file-text, user). Arc commands from the real Lucide SVGs are converted to
// sharp corners / beziers since Figma's vectorPaths has no arc command —
// same silhouette and proportions, just without micro-corner-rounding that's
// invisible at 20px anyway.
const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  console.log(`[${type}]`, data.result.summary || data.result.id);
  return data.result;
}

const HOUSE_PATH = "M 3 10 L 12 2 L 21 10 L 21 21 L 3 21 Z M 15 21 L 15 13 L 11 13 L 11 21";
const FILE_TEXT_PATH = "M 6 22 L 6 4 L 14 4 L 20 10 L 20 22 Z M 14 4 L 14 10 L 20 10 M 8 9 L 10 9 M 8 13 L 16 13 M 8 17 L 16 17";
const USER_BODY_PATH = "M 19 21 L 19 19 L 15 15 L 9 15 L 5 19 L 5 21";

const variants = [
  { comp: "14006:150", icon: "14006:151", path: HOUSE_PATH, active: true },
  { comp: "14006:155", icon: "14006:156", path: HOUSE_PATH, active: false },
  { comp: "14006:158", icon: "14006:159", path: FILE_TEXT_PATH, active: true },
  { comp: "14006:161", icon: "14006:162", path: FILE_TEXT_PATH, active: false },
  { comp: "14006:164", icon: "14006:165", path: null, active: true, isUser: true },
  { comp: "14006:167", icon: "14006:168", path: null, active: false, isUser: true },
];

const ACTIVE_COLOR = { r: 0.0941, g: 0.0941, b: 0.102 };
const INACTIVE_COLOR = { r: 0.6, g: 0.6, b: 0.62 };

async function main() {
  for (const v of variants) {
    const color = v.active ? ACTIVE_COLOR : INACTIVE_COLOR;
    await cmd("DELETE_NODE", { id: v.icon });
    if (v.isUser) {
      // Plain (non-auto-layout) wrapper so head+body compose as one glyph
      // via explicit x/y, instead of being auto-layout-stacked with the label.
      const wrap = await cmd("CREATE_FRAME", { parentId: v.comp, name: "Icon", width: 20, height: 20, fill: { r: 1, g: 1, b: 1, a: 0 } });
      await cmd("CREATE_ELLIPSE", { parentId: wrap.id, name: "Icon Head", strokeColor: color, strokeWeight: 1.7, width: 6.7, height: 6.7, x: 6.7, y: 0 });
      await cmd("CREATE_VECTOR", { parentId: wrap.id, name: "Icon Body", path: USER_BODY_PATH, strokeColor: color, strokeWeight: 1.7, width: 20, height: 9.3, x: 0, y: 10.7 });
    } else {
      await cmd("CREATE_VECTOR", { parentId: v.comp, name: "Icon", path: v.path, strokeColor: color, strokeWeight: 1.7, width: 20, height: 20 });
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
