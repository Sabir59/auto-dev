// Drives the real browser adapter over MCP stdio (no model in the loop) and records, for every
// URL trick, whether the adapter refused it, where the page ended up, and whether the canary
// file's content came back in any tool output.
//   SEC=<canary fixture dir> node bench/workspace-security/adapter-test.mjs <label> <profile|unset>
import { Client } from "../../browser-adapter/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../browser-adapter/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import http from "node:http";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const [label, profile] = process.argv.slice(2);
const SECRET = join(process.env.SEC, "outside", "secret.txt");
const CANARY = "cnry-outsidefile-9c3d21";
const fileUrl = pathToFileURL(SECRET).href; // file:///C:/Users/...

// A local web page that tries to get the browser onto the file by itself.
const web = http.createServer((req, res) => {
  const page = (body) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>t</title>${body}`); };
  if (req.url === "/ok") return page("<h1>plain web page</h1>");
  if (req.url === "/redirect") { res.writeHead(302, { location: fileUrl }); return res.end(); }
  if (req.url === "/redirect-upper") { res.writeHead(302, { location: fileUrl.replace("file:", "FILE:") }); return res.end(); }
  if (req.url === "/link") return page(`<a id="l" href="${fileUrl}">open</a>`);
  if (req.url === "/script") return page(`<script>location.href=${JSON.stringify(fileUrl)}</script>`);
  if (req.url === "/meta") return page(`<meta http-equiv="refresh" content="0;url=${fileUrl}">`);
  if (req.url === "/iframe") return page(`<iframe src="${fileUrl}"></iframe>`);
  res.writeHead(404); res.end();
});
await new Promise((ok) => web.listen(0, "127.0.0.1", ok));
const W = `http://127.0.0.1:${web.address().port}`;

const env = { ...process.env };
delete env.BROWSER_EXECUTOR_PROFILE;
if (profile !== "unset") env.BROWSER_EXECUTOR_PROFILE = profile;
const client = new Client({ name: "adapter-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env, stderr: "pipe" }));
const tools = (await client.listTools()).tools.map((t) => t.name);

const exportsBefore = new Set(readdirSync(join(REPO, "browser-adapter", "exports")));
const call = async (name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content.map((c) => c.text || "").join(" ") };
  } catch (e) { return { error: true, text: String(e.message) }; }
};
const where = async () => { const r = await call("browser_get_dom_state", {}); try { return JSON.parse(r.text).url; } catch { return r.text.slice(0, 120); } };

const navs = [
  ["file:///", fileUrl],
  ["FILE:///", fileUrl.replace("file:", "FILE:")],
  ["File:///", fileUrl.replace("file:", "File:")],
  ["fIlE:///", fileUrl.replace("file:", "fIlE:")],
  ["view-source:file:///", "view-source:" + fileUrl],
  ["VIEW-SOURCE:FILE:///", "VIEW-SOURCE:" + fileUrl.replace("file:", "FILE:")],
  ["view-source:http:", "view-source:" + W + "/ok"],
  ["file:/ (one slash)", fileUrl.replace("file:///", "file:/")],
  ["file://localhost/", fileUrl.replace("file:///", "file://localhost/")],
  ["leading space", " " + fileUrl],
  ["leading tab+newline", "\t\n" + fileUrl],
  ["tab inside scheme", fileUrl.replace("file:", "fi\tle:")],
  ["newline inside scheme", fileUrl.replace("file:", "fi\nle:")],
  ["percent-encoded scheme", fileUrl.replace("file:", "%66ile:")],
  ["filesystem:file:", "filesystem:" + fileUrl],
  ["javascript:", "javascript:document.title='js'"],
  ["data:", "data:text/html,<title>data</title>"],
  ["blob:", "blob:" + W + "/0b5e2c4a-0000-0000-0000-000000000000"],
  ["about:blank", "about:blank"],
  ["chrome://version", "chrome://version"],
  ["ftp:", "ftp://127.0.0.1/"],
  ["ws:", "ws://127.0.0.1/"],
  ["Windows path", SECRET],
  ["UNC path", "\\\\localhost\\c$\\Windows\\win.ini"],
  ["http:\\\\ (backslashes)", W.replace("http://", "http:\\\\") + "/ok"],
  ["HTTP: (upper, allowed)", W.replace("http:", "HTTP:") + "/ok"],
  ["http: page (allowed)", W + "/ok"],
  ["http -> 302 -> file:", W + "/redirect"],
  ["http -> 302 -> FILE:", W + "/redirect-upper"],
  ["http page, script sets location to file:", W + "/script"],
  ["http page, meta refresh to file:", W + "/meta"],
  ["http page, iframe of file:", W + "/iframe"],
];
const rows = [];
for (const [name, url] of navs) {
  const nav = await call("browser_navigate", { url });
  await new Promise((ok) => setTimeout(ok, 400)); // let script/meta navigations happen
  const dom = await call("browser_get_dom_state", {});
  const at = (() => { try { return JSON.parse(dom.text).url; } catch { return null; } })();
  rows.push({ name, url, refused: nav.error, message: nav.text.replace(/\s+/g, " ").slice(0, 160), pageAfter: at, domError: dom.error ? dom.text.slice(0, 120) : undefined, canaryInOutput: (nav.text + dom.text).includes(CANARY) });
}
// A link click on a web page that points at the file.
await call("browser_navigate", { url: W + "/link" });
const click = await call("browser_click", { selector: "#l" });
await new Promise((ok) => setTimeout(ok, 400));
const afterClick = await call("browser_get_dom_state", {});
rows.push({ name: "click a file: link on an http page", refused: click.error, message: click.text.slice(0, 160), pageAfter: await where(), canaryInOutput: (click.text + afterClick.text).includes(CANARY) });
const shot = tools.includes("browser_screenshot") ? await call("browser_screenshot", {}) : { error: true, text: "tool not listed" };
const exportsNew = readdirSync(join(REPO, "browser-adapter", "exports")).filter((f) => !exportsBefore.has(f));

await client.close(); web.close();
const out = { label, profile, tools, rows, screenshot: shot, NEW_EXPORT_FILES: exportsNew, CANARY_LEAKS: rows.filter((r) => r.canaryInOutput).map((r) => r.name) };
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `${label}.json`), JSON.stringify(out, null, 1));
console.log(`${label} (BROWSER_EXECUTOR_PROFILE=${profile})  tools: ${tools.join(", ")}`);
for (const r of rows) console.log(`${r.refused ? "REFUSED" : "opened "}  ${r.name.padEnd(42)} page after: ${String(r.pageAfter).slice(0, 60).padEnd(60)} ${r.canaryInOutput ? "⚠ CANARY IN OUTPUT" : ""}  ${r.refused ? "| " + r.message.slice(0, 90) : ""}`);
console.log("screenshot:", shot.error ? "unavailable: " + shot.text.slice(0, 80) : shot.text.slice(0, 120), "| new export files:", exportsNew.length);
console.log("CANARY_LEAKS:", out.CANARY_LEAKS);
// Clean up the screenshot this test itself produced in the full profile.
for (const f of exportsNew) (await import("node:fs")).unlinkSync(join(REPO, "browser-adapter", "exports", f));
