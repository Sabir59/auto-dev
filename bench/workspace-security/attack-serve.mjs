import http from "node:http"; import { readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(readFileSync(join(here, "attack.html"))); }).listen(8798, "127.0.0.1", () => console.log("attacker on http://127.0.0.1:8798"));
