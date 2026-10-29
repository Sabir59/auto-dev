// Figma desktop's own MCP server (Dev Mode): where it is, how to turn it on, and a check that it's
// there. No dependencies, so the console (worker-ui/server.mjs) can use it too.
export const DESKTOP_MCP_URL = process.env.FIGMA_DESKTOP_MCP_URL || "http://127.0.0.1:3845/mcp";
export const SETUP = "In the Figma desktop app: open the file, switch to Dev Mode (Shift+D), and in the right-hand panel's MCP section turn on the desktop MCP server (or Figma menu → Preferences → Enable Dev Mode MCP Server). It needs a Dev or Full seat.";

// { ok, state, detail }: an MCP initialize to the server; only an answer from Figma's server counts.
export async function desktopStatus(url = DESKTOP_MCP_URL, timeout = 4000) {
  let r;
  try {
    r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-workforce-check", version: "1" } } }) });
  } catch (e) { return { ok: false, state: "Not running", detail: e.name === "TimeoutError" ? "no answer" : "Figma desktop's MCP server is off, or Figma desktop isn't open" }; }
  const body = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, state: "Not answering", detail: `answered ${r.status}` };
  const name = body.match(/"name"\s*:\s*"([^"]*Figma[^"]*)"/)?.[1];
  return name ? { ok: true, state: "Running", detail: name } : { ok: false, state: "Something else is on that port", detail: new URL(url).host };
}
