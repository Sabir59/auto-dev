// Extracts design/spec/icons.json equivalent: every icon component in a
// Figma file (found via GET_ICON_COMPONENTS), each checked LIVE against
// Lucide's real published icon set — not a hardcoded/remembered list, since
// that list changes over time (e.g. Lucide has since added "mosque").
//
// Usage: node extract-icons.mjs <pageId> [--prefix icon/] [--out path.json]
const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function isRealLucideIcon(kebabName) {
  const url = `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${kebabName}.svg`;
  const res = await fetch(url, { method: "HEAD" });
  return res.ok;
}

async function main() {
  const [pageId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!pageId) throw new Error("Usage: node extract-icons.mjs <pageId> [--prefix icon/] [--out path.json]");
  const args = process.argv.slice(2);
  const prefixFlag = args.indexOf("--prefix");
  const outFlag = args.indexOf("--out");
  const prefix = prefixFlag !== -1 ? args[prefixFlag + 1] : "icon/";
  const outPath = outFlag !== -1 ? args[outFlag + 1] : null;

  const { icons } = await cmd("GET_ICON_COMPONENTS", { pageId, prefix });
  console.log(`Found ${icons.length} icon components. Checking each against Lucide's real icon set...`);

  const results = [];
  for (const icon of icons) {
    const kebab = icon.figmaName.slice(prefix.length);
    const real = await isRealLucideIcon(kebab);
    results.push({ figma: icon.figmaName, component: icon.suggestedComponentName, custom: !real });
    console.log(`  ${real ? "✓" : "✗ CUSTOM"} ${icon.figmaName} -> ${icon.suggestedComponentName}`);
  }

  const customCount = results.filter((r) => r.custom).length;
  console.log(`\n${results.length} icons checked · ${customCount} custom (not in Lucide)`);

  const output = {
    section: "icons",
    library: "lucide-react-native (same icons as lucide-react / Figma)",
    icons: results.sort((a, b) => a.figma.localeCompare(b.figma)),
  };
  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, JSON.stringify(output, null, 1) + "\n");
    console.log(`Written to ${outPath}`);
  }
  return output;
}

main().catch((e) => { console.error(e); process.exit(1); });
