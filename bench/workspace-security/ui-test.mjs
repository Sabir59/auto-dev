// The console's own page, in a real browser, against a console on the given port: start a run
// from the chat box, see the live reply arrive over SSE, send a live follow-up, end the run.
//   node bench/workspace-security/ui-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || "8797";
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
const out = { port };
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector("#runs");
out.runsListed = await page.locator("#runs > *").count();
await page.click("#newRun");
await page.fill("#input", "Reply with exactly: UI-OK");
await page.click("#send");
await page.waitForFunction(() => document.querySelector("#chat").innerText.includes("UI-OK") && document.querySelector("#status").textContent === "waiting", null, { timeout: 300000 });
out.firstReplyShown = true;
await page.fill("#input", "Reply with exactly: UI-LIVE");
await page.click("#send");
await page.waitForFunction(() => document.querySelector("#chat").innerText.includes("UI-LIVE") && document.querySelector("#status").textContent === "waiting", null, { timeout: 300000 });
out.liveFollowUpShown = true;
await page.click("#endBtn");
await page.waitForFunction(() => document.querySelector("#status").textContent === "finished", null, { timeout: 60000 });
out.endedStatus = await page.textContent("#status");
out.consoleErrors = consoleErrors;
await browser.close();
writeFileSync(join(HERE, "results", "E-ui.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
