// The per-call check for an integration's tools. When the console starts a run, it gives each
// integration tool server the address to ask (AIW_AUTHZ_URL) and the run's token (AIW_AUTHZ_TOKEN).
// Every tool call then asks the console first whether it's still allowed: the run is active, the
// capability was given to it, and the accounts it needs are still available (worker-ui/server.mjs
// authorizeCall). Anything other than a clear yes — a refusal, an error, no answer within 8 seconds
// — and the call isn't made. Without AIW_AUTHZ_URL (a server used on its own, outside the console,
// as the Figma Executor's own tests do) nothing changes.
//
// The tools also follow what's connected now. Each starts disabled; before the server connects and
// every 2 seconds after, it asks the console which of the run's capabilities are connected
// (GET <AIW_AUTHZ_URL>/live) and enables exactly their tools. Enabling or disabling one sends
// notifications/tools/list_changed, so the runtime's tool list changes in the same session: a
// connection that comes up mid-task brings its tools into that task. No answer means all off.
// Being listed isn't being allowed: every call is still checked as above.
export function guardTools(server, capabilityFor) {
  const url = process.env.AIW_AUTHZ_URL, token = process.env.AIW_AUTHZ_TOKEN || "", name = process.env.AIW_AUTHZ_SERVER || "";
  if (!url) return;
  const register = server.registerTool.bind(server), byCap = new Map();
  server.registerTool = (tool, config, handler) => {
    const t = register(tool, config, async (...args) => {
      const cap = capabilityFor(tool);
      let verdict;
      try {
        const r = await fetch(`${url}?cap=${encodeURIComponent(cap)}&tool=${encodeURIComponent(tool)}`, { headers: { "x-aiw-authz": token }, signal: AbortSignal.timeout(8000) });
        verdict = await r.json().catch(() => ({ ok: false, reason: `the console answered ${r.status}` }));
        if (!r.ok) verdict.ok = false;
      } catch (e) { verdict = { ok: false, reason: `the console couldn't confirm access (${e.name === "TimeoutError" ? "no answer in time" : e.message})` }; }
      if (verdict?.ok !== true) return { isError: true, content: [{ type: "text", text: `NOT_AUTHORIZED: ${verdict?.reason || "access couldn't be confirmed"}. Nothing was done. If the task needs it, write a NEEDS: line saying what has to be connected.` }] };
      return handler(...args);
    });
    if (t) { t.disable(); const cap = capabilityFor(tool); if (!byCap.has(cap)) byCap.set(cap, []); byCap.get(cap).push(t); }
    return t;
  };
  // at/on: the version this server last applied and how many tools it has on, for the console to
  // confirm a change reached it.
  let at = null, busy = false;
  async function sync() {
    if (busy) return; busy = true;
    let state = null;
    try {
      const on = [...byCap.values()].flat().filter((t) => t.enabled).length;
      const r = await fetch(`${url}/live?server=${encodeURIComponent(name)}&at=${at ?? ""}&on=${on}`, { headers: { "x-aiw-authz": token }, signal: AbortSignal.timeout(10000) });
      const b = r.ok ? await r.json().catch(() => null) : null;
      if (Array.isArray(b?.live)) state = b;
    } catch {}
    try {
      if (state && state.v === at) return;
      const live = new Set(state?.live || []);
      for (const [cap, tools] of byCap) for (const t of tools) { const want = live.has(cap); if (t.enabled !== want) (want ? t.enable() : t.disable()); }
      at = state ? state.v : null;
    } finally { busy = false; }
  }
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await sync(); // the first tool list is already the right one
    const r = await connect(transport);
    setInterval(sync, 2000).unref();
    return r;
  };
}
