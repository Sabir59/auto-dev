// A local stand-in for Builder's three documented APIs, for the adapter's automated tests only.
// It follows the request shapes the adapter uses (builder-adapter/builder.mjs); it is NOT evidence
// of Builder's real behaviour. Every request is recorded so tests can prove what was (not) sent.
import http from "node:http";

export const KEYS = { public: "pub-test-0123456789", private: "bpk-test-SECRET-abcdef0123456789" };

export function startMock({ port = 0 } = {}) {
  const models = [{ id: "m-page", name: "page", kind: "page" }, { id: "m-banner", name: "announcement-bat", kind: "data" }];
  const entries = new Map();
  const seed = (e) => entries.set(e.id, { createdDate: Date.now(), lastUpdated: Date.now(), query: [], data: {}, ...e });
  seed({ id: "seedpublished01", modelName: "page", name: "Live page", published: "published", firstPublished: Date.now(), data: { url: "/live", title: "Live" }, query: [{ property: "urlPath", operator: "is", value: "/live" }] });
  seed({ id: "seeddraft00001", modelName: "page", name: "Existing draft", published: "draft", data: { url: "/draft", title: "Draft" } });
  const log = [];
  const fault = { publishIgnored: false, publishStatus: 0 }; // simulate an API that says OK without publishing, or refuses
  let n = 0;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : null;
      log.push({ method: req.method, path: u.pathname, search: Object.fromEntries(u.searchParams), auth: req.headers.authorization || null, body: b });
      const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const bearerOk = req.headers.authorization === `Bearer ${KEYS.private}`;

      if (u.pathname === "/api/v2/admin" && req.method === "POST") {
        if (!bearerOk) return send(401, { message: "Unauthorized" });
        return send(200, { data: { models } });
      }
      let m = /^\/api\/v3\/content\/([^/]+)$/.exec(u.pathname);
      if (m && req.method === "GET") {
        if (u.searchParams.get("apiKey") !== KEYS.public) return send(401, { message: "Invalid apiKey" });
        if (!models.some((x) => x.name === m[1])) return send(404, { message: `Model ${m[1]} not found` });
        const incl = u.searchParams.get("includeUnpublished") === "true";
        let rows = [...entries.values()].filter((e) => e.modelName === m[1] && (incl ? e.published !== "archived" : e.published === "published"));
        const qid = u.searchParams.get("query.id");
        if (qid) rows = rows.filter((e) => e.id === qid);
        const off = Number(u.searchParams.get("offset") || 0), lim = Number(u.searchParams.get("limit") || 30);
        return send(200, { results: rows.slice(off, off + lim).map(({ modelName, ...e }) => e) });
      }
      m = /^\/api\/v1\/write\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
      if (m) {
        if (!bearerOk) return send(401, { message: "Unauthorized" });
        if (!models.some((x) => x.name === m[1])) return send(404, { message: `Model ${m[1]} not found` });
        if (req.method === "POST" && !m[2]) {
          const id = `created${String(++n).padStart(8, "0")}`;
          seed({ id, modelName: m[1], name: b.name, published: b.published || "draft", data: b.data || {}, query: b.query || [] });
          return send(200, { id, name: b.name, published: b.published || "draft", data: b.data });
        }
        if (req.method === "PATCH" && m[2]) {
          const e = entries.get(m[2]);
          if (!e || e.modelName !== m[1]) return send(404, { message: "Not found" });
          if (b.published === "published" && fault.publishStatus) return send(fault.publishStatus, { message: "Publishing is not allowed for this key" });
          const next = { ...e, ...(b.name !== undefined ? { name: b.name } : {}), data: b.data ? { ...e.data, ...b.data } : e.data, lastUpdated: Date.now() };
          if (b.published && !(b.published === "published" && fault.publishIgnored)) { next.published = b.published; if (b.published === "published" && !e.firstPublished) next.firstPublished = Date.now(); }
          entries.set(e.id, next);
          return send(200, { id: e.id, name: next.name, published: b.published ?? next.published });
        }
      }
      send(404, { message: "no route" });
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, port: server.address().port, entries, log, fault, close: () => new Promise((r) => server.close(r)) })));
}
