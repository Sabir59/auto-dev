// The changes to effective access made on purpose since the recording (golden-effective.json),
// each with its reason. effective-test.mjs applies them to the recording before comparing, so any
// other difference fails.
const sortServers = (s) => Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)));
const withEvolve = (g) => ({ ...g, allowedTools: [...g.allowedTools, "mcp__evolve"].sort(), servers: sortServers({ ...g.servers, evolve: {} }) });
const withoutEvolve = (g) => ({ ...g, allowedTools: g.allowedTools.filter((t) => t !== "mcp__evolve"), servers: sortServers(Object.fromEntries(Object.entries(g.servers).filter(([n]) => n !== "evolve"))) });
export default {
  reasons: [
    "General worker (decision 1): only the core capabilities granted to it (by default files.read, files.write, shell, web, browser), never an integration's tools. Before, outside policies and the hosted product, it ran on the profile's flags: every built-in tool in a Work workspace (no --tools limit), the Figma executor, and no --permission-prompts none. Now it launches exactly as a worker with those core capabilities does.",
    "Shell off by default (2026-10-29): the General worker's default core tools no longer include shell (node, curl); a shell command runs with the person's OS permissions, outside every file rule, so it's granted only explicitly (General settings or a worker's definition). The coreDefault worker in effective-test.mjs follows the new default.",
    "Worker evolution (2026-10-28, docs/worker-evolution.md): every defined worker also gets the evolve tool server (mcp__evolve: read its own definition, propose a change to it; nothing that approves or edits). It reads and writes only console records about that worker, through the console, with its run's token. The General worker has no definition, so it doesn't get it.",
  ],
  // (launch name, recorded shape, planned shapes now) → the shape expected now
  expect: (launch, g, now) => {
    if (launch.startsWith("General @ ")) return withoutEvolve(now[launch.replace("General", "coreDefault")]);
    return withEvolve(g);
  },
  // (request name, recorded composition) → the composition expected now
  compose: (request, g) => g,
};
