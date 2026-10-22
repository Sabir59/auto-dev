// What a worker can be connected to, and what it takes to configure one for a person's request.
//
// A person describes the work in their own words ("manage products in my Shopify store", "build
// features in my Next.js repository"). The console recognises the tools and systems that involves,
// asks only those integrations' questions, and composes an ordinary worker definition from the
// answers (worker-platform.md §13). This file is the registry: each integration says what really
// exists for it today, its questions, and what each answer turns on. It describes integrations, not
// job titles: any combination can be requested, and anything the registry doesn't know is named
// and reported as not connected.
//
// What an answer can do: add capabilities and requirements from the console's fixed catalogues,
// steps, knowledge and limits (instructions to the worker), an approval note, or bring in another
// integration (a Shopify products CSV is the "files" integration). What it can't do: grant access.
// The definition still runs through workerRuntime (capabilities ∩ workspace mode ∩ Team scope ∩
// platform), requirements are only checked, and the adapters enforce their own limits.
//
// connector: true  — a real, tested implementation exists (an adapter or built-in tools).
// connector: false — recognised, but there's no connector: the request is answered honestly, with
//                    what can be done today instead (often another integration).
//
// Question types: choice (one), multi (several), text (context for the worker, never access), info.
// `when: { q, is: [...] }` shows a question only for those answers. `required` with no default: the
// person has to answer before the worker can be created (a follow-up, not a guess).

const YES = (caps, extra = {}) => ({ id: "yes", label: "Yes", caps, ...extra });
const NO = { id: "no", label: "No", caps: [] };

export const INTEGRATIONS = [
  { id: "gitsync", label: "Git branch sync and promotion", short: "Git sync", connector: true, workspace: "project",
    summary: "Shows which changes each branch is missing and who they belong to, and plans synchronisation and promotion between branches, simulated with Git before anything happens (worker-ui/gitflow.mjs).",
    detect: ["sync", "synchroni[sz]e", "synchroni[sz]ation", "in sync", "cherry-?picks?", "promote", "promotion", "branches"], absorbs: ["code"],
    caps: ["gitflow.read"], name: (a) => (a.team ? `${a.team} branch sync worker` : "Branch sync worker"), specialization: () => "Git branch synchronisation and promotion between teams",
    steps: ["Read the Git workflow configuration (gitflow_overview) before anything else", "Base every statement about a commit on gitflow_commits / gitflow_commit evidence, and say when ownership or a relationship is uncertain", "Explain plans from gitflow_preview: what is blocked, why, and what a person must decide"],
    limits: ["Never claim a change is safe to apply because it looks like it belongs to the team: the plan's evidence decides.", "Never invent a ticket, pull request or relationship between commits that the evidence doesn't show.", "You can't create branches, merge or push: the person approves and runs plans on the Git workflow page."],
    starters: ["Explain the changes waiting for each branch relationship: who they belong to, which are blocked and why. Don't change anything."],
    questions: [
      { id: "team", type: "text", label: "Your team", placeholder: "e.g. BAU", knowledge: "Team" },
      { id: "others", type: "text", label: "Other teams in the repository", placeholder: "e.g. Innovax", knowledge: "Other teams" },
      { id: "mappings", type: "text", label: "Branch relationships", placeholder: "dev-main → sabir-dev; uat-main → sabir-uat; sabir-uat → preprod-main", knowledge: "Branch relationships",
        prefill: [["sabir-dev|sabir-uat", "dev-main → sabir-dev; uat-main → sabir-uat; sabir-uat → preprod-main"]] },
      { id: "writes", type: "choice", label: "What may it prepare?", default: "preview", help: "Analysis and plans are simulated with Git and change nothing. A proposal branch is a NEW branch with a plan's result, created only when you approve that plan; nothing is ever pushed or written to an existing branch.", choices: [
        { id: "preview", label: "Previews and reports only", approval: "It changes nothing in the repository." },
        { id: "propose", label: "Also proposal branches, when I approve", approval: "Each proposal branch needs your approval on the Git workflow page; you push it and open the pull request yourself." }] },
      { id: "setup", type: "info", label: "After creating it", text: "Its Git workflow page has the rest: people and their identities, branch patterns, overrides and exclusion rules." },
    ] },

  { id: "code", label: "Code repository", short: "Code", connector: true, workspace: "project",
    summary: "Reads and changes code in a project folder on this computer (a Git checkout).",
    detect: ["repo", "repository", "codebase", "source code", "react", "next\\.?js", "vue", "nuxt", "angular", "svelte", "typescript", "javascript", "frontend", "front-end", "backend", "pull request", "refactor", "unit tests?"],
    caps: ["files.read"], name: (a) => (a.stack ? `${a.stack} engineer` : "Engineer"), specialization: (a) => `${a.stack || "Software"} development in an existing codebase`,
    steps: ["Read the conventions and architecture documents before touching code", "Find the existing code, hooks and components that already solve part of it", "Make the smallest change that fits the existing architecture"],
    limits: ["Never invent APIs, files or components you haven't seen in the repository.", "Never delete or rewrite unrelated code.", "Don't commit or push: the person reviews the changes and commits them."],
    starters: ["Look through this repository and describe its structure, stack and conventions. Don't change anything."],
    questions: [
      { id: "stack", type: "text", label: "Framework and stack", placeholder: "e.g. Next.js 14, React, Tailwind", knowledge: "Stack",
        prefill: [["next\\.?js", "Next.js"], ["nuxt", "Nuxt"], ["react", "React"], ["vue", "Vue"], ["angular", "Angular"], ["svelte", "Svelte"], ["wordpress", "WordPress (PHP)"], ["shopify", "Shopify theme (Liquid)"]] },
      { id: "conventions", type: "text", label: "Conventions or documents it must follow", placeholder: "e.g. docs/architecture.md; business logic stays out of components", knowledge: "Conventions to follow" },
      { id: "change", type: "choice", label: "What may it do with the code?", default: "edit", choices: [
        { id: "read", label: "Read and explain only", limits: ["Don't change files: describe the change you'd make."], approval: "It can't change files: it reads and explains." },
        { id: "edit", label: "Change code", caps: ["files.write"], reqs: [["workspace", "write", "required"]], approval: "Its changes stay in the working copy until you review and commit them (Changes & versions)." }] },
      { id: "scripts", type: "choice", label: "Run Node scripts, such as tests and builds", default: "yes",
        help: "Only node and curl commands (for example node node_modules/jest/bin/jest.js). npm, npx and other programs aren't available. Turned off in Inspect workspaces and under a protected-branch policy.",
        choices: [YES(["shell"]), NO] },
      { id: "browser", type: "choice", label: "Check the result in a browser", default: "yes", help: "Opens your local dev server or a site to look at what changed.",
        choices: [YES(["browser"], { reqs: [["browser", "use", "optional"]] }), NO] },
      { id: "git", type: "info", label: "Commits and pushes", text: "Stay yours, from Changes & versions. To let a worker commit through GitHub, register the repository on the GitHub page and grant this worker access in its full definition." },
    ] },

  { id: "builder", label: "Builder.io", short: "Builder.io", connector: true, workspace: "any",
    summary: "Reads, drafts and (if you allow it) publishes content in a Builder.io space, through the Builder adapter.",
    detect: ["builder(\\.io)?"],
    caps: ["builder.read"], reqs: [["builder", "read", "required"]], name: () => "Builder.io content worker", specialization: () => "Builder.io content and pages",
    steps: ["Find what already exists (models, entries, the page's url) before creating anything", "Update an existing entry rather than creating a second one for the same page", "Verify the result with builder_verify_content"],
    limits: ["Never create a second entry for content that already exists: update it.", "Never claim a page is live unless builder_verify_content says servedAsLive: true."],
    starters: ["List the models and pages in the Builder space, and say which are live. Don't change anything."],
    questions: [
      { id: "space", type: "text", label: "Builder space", placeholder: "e.g. MATW test space", knowledge: "Builder space" },
      { id: "models", type: "text", label: "Models and pages it works on", placeholder: "e.g. page, hero-section; /zakat", knowledge: "Models and pages" },
      { id: "publishing", type: "choice", label: "What may it do with content?", default: "drafts",
        help: "Writes only ever go to a Builder space marked as a test space on this computer: the adapter refuses production spaces, whatever you choose here.",
        choices: [
          { id: "read", label: "Read only", approval: "It can't change content." },
          { id: "drafts", label: "Prepare drafts; a person publishes", caps: ["builder.write.draft"], reqs: [["builder", "write", "required"]], approval: "It saves drafts; publishing is yours (it has no publish tool)." },
          { id: "publish", label: "Create, update and publish", caps: ["builder.write"], reqs: [["builder", "write", "required"]], limits: ["Publish only when the task asks for it."], approval: "It can publish, in test spaces only." }] },
      { id: "check", type: "choice", label: "Check pages on the site", default: "yes", choices: [YES(["browser"]), NO] },
      { id: "site", type: "text", label: "Site address", placeholder: "e.g. http://localhost:3000", knowledge: "Site to check pages on", when: { q: "check", is: ["yes"] } },
    ] },

  { id: "figma", label: "Figma", short: "Figma", connector: true, workspace: "any",
    summary: "Reads and edits the file open in the Figma desktop app (AI Executor plugin), and reads files by link with a Figma token.",
    detect: ["figma"],
    caps: [], name: () => "Figma design worker", specialization: () => "Interface design in Figma",
    steps: ["Inspect the existing design (pages, styles, components) before changing anything", "Build alongside existing work; export and look at the result to check it"],
    limits: ["Never delete or replace existing designs unless the task asks for it."],
    starters: ["Describe the open Figma file: its pages, main frames and components. Don't change anything."],
    questions: [
      { id: "file", type: "text", label: "Figma file", placeholder: "https://www.figma.com/design/…", knowledge: "Figma file", help: "A link is context, not access: editing needs the plugin running in that file; reading by link needs a Figma token on this computer." },
      { id: "edit", type: "choice", label: "In the open file it may", default: "edit", choices: [
        { id: "edit", label: "Edit", caps: ["figma.plugin.read", "figma.plugin.edit"], reqs: [["figma", "edit", "required"]], approval: "It edits the live Figma file (Figma's own version history is the undo)." },
        { id: "look", label: "Only look", caps: ["figma.plugin.read"], approval: "It can't change the Figma file." }] },
      { id: "links", type: "choice", label: "Read other files by their link", default: "no", choices: [YES(["figma.read"], { reqs: [["figma", "read", "required"]] }), NO] },
    ] },

  { id: "browser", label: "Websites in a browser", short: "Browser", connector: true, workspace: "any",
    summary: "Opens and reads web pages in a real browser; in a Work workspace it can also click, fill forms and take screenshots.",
    detect: ["browser", "web ?pages?", "websites?", "https?://"],
    caps: ["browser"], reqs: [["browser", "use", "required"]], name: () => "Web worker", specialization: () => "Work on web pages",
    steps: ["Open the pages involved and read them before acting"], limits: ["Never submit a form that sends money, messages or personal data unless the task asks for exactly that."],
    starters: ["Open the start page and describe what's on it. Don't submit anything."],
    questions: [
      { id: "start", type: "text", label: "Start address", placeholder: "https://…", knowledge: "Start address" },
      { id: "how", type: "info", label: "What it can do", text: "In an Inspect workspace it only opens and reads pages; in Work it can also click, fill forms and take screenshots. It uses a fresh browser with no saved logins." },
    ] },

  { id: "web", label: "Web research", short: "Research", connector: true, workspace: "any",
    summary: "Searches the web and reads public pages.",
    detect: ["research", "competitors?", "search the web", "sources", "market", "news"],
    caps: ["web"], name: () => "Research worker", specialization: () => "Research from the web",
    steps: ["Search, then read the primary sources", "Cross-check facts that matter in a second source"],
    limits: ["Say where every fact comes from, with a link."],
    starters: ["Find three reliable sources on the topic and summarise what each says, with links."],
    questions: [
      { id: "topics", type: "text", label: "Topics and sources to prefer", placeholder: "e.g. UK charity donation sites; official reports first", knowledge: "Topics and sources" },
      { id: "how", type: "info", label: "Where it works", text: "Searching needs a Work workspace; Scratch is one." },
    ] },

  { id: "files", label: "Files in a folder", short: "Files", connector: true, workspace: "any",
    summary: "Reads and writes files (CSV, Markdown, JSON, text) in the workspace folder.",
    detect: ["csv", "spreadsheets?", "excel", "xlsx", "markdown", "documents?", "reports?"],
    caps: ["files.read"], name: () => "Files worker", specialization: () => "Work on files in a folder",
    steps: ["Read the files involved before changing them"], limits: ["Keep a file's format (columns, headers) unless the task asks to change it."],
    starters: ["List the files in this folder and summarise what each one contains. Don't change anything."],
    questions: [
      { id: "which", type: "text", label: "Files it works on", placeholder: "e.g. data/products.csv, reports/", knowledge: "Files" },
      { id: "change", type: "choice", label: "What may it do with them?", default: "edit", choices: [
        { id: "read", label: "Read and analyse only", limits: ["Don't change files: report what you found."], approval: "It can't change files." },
        { id: "edit", label: "Create and edit files", caps: ["files.write"], reqs: [["workspace", "write", "required"]], approval: "Its file changes are yours to review (and to commit, in a Git folder)." }] },
      { id: "xlsx", type: "info", label: "Spreadsheets", text: "Excel (.xlsx) files can't be read directly: save them as CSV." },
    ] },

  // ---- recognised, no connector ----
  { id: "shopify", label: "Shopify", connector: false, workspace: "any",
    detect: ["shopify"],
    why: "There's no Shopify connector yet: a worker can't sign in to your store, or read or change its products, inventory, orders, pages or settings.",
    questions: [
      { id: "store", type: "text", label: "Store", placeholder: "yourstore.myshopify.com", knowledge: "Shopify store" },
      { id: "scope", type: "multi", label: "What should it work on?", required: true, choices: [
        { id: "catalog", label: "Products and inventory", adds: ["files", { change: "edit" }], know: "Products and inventory come from a CSV exported in Shopify admin (Products → Export). The worker edits that file; the person imports it back (Products → Import).",
          unsupported: "Changing products or stock in the live store (needs the Shopify Admin API)." },
        { id: "orders", label: "Orders", adds: ["files", {}], know: "Orders come from a CSV exported in Shopify admin (Orders → Export), for analysis.", unsupported: "Reading or changing orders in the store itself (needs the Shopify Admin API)." },
        { id: "theme", label: "Theme and storefront code", adds: ["code", { stack: "Shopify theme (Liquid)" }], know: "The theme's code (Liquid, sections, assets) is in the project folder, e.g. pulled with Shopify CLI; the person pushes and publishes it." },
        { id: "content", label: "Pages, blog posts and navigation", unsupported: "Editing store pages, blog posts or navigation (needs the Shopify Admin API)." }] },
      { id: "review", type: "info", label: "Review", text: "Whatever it changes is a file in a folder: you review it, then import or publish it in Shopify yourself. Nothing reaches the live store from here." },
    ] },

  { id: "sheets", label: "Google Sheets", connector: false, workspace: "any",
    detect: ["google ?sheets?", "sheets", "google drive", "gsheets?"],
    why: "There's no Google connector yet: a worker can't open, read or edit Google Sheets or other Drive files.",
    questions: [
      { id: "which", type: "text", label: "Which spreadsheets", placeholder: "e.g. Donations 2026, Competitor tracker", knowledge: "Spreadsheets" },
      { id: "scope", type: "choice", label: "What should it do with them?", required: true, choices: [
        { id: "analyse", label: "Read and analyse", adds: ["files", { change: "read" }], know: "Spreadsheets arrive as CSV files downloaded from Google Sheets (File → Download → CSV).", unsupported: "Reading the live Google Sheet." },
        { id: "edit", label: "Update them", adds: ["files", { change: "edit" }], know: "Spreadsheets arrive as CSV downloads (File → Download → CSV); the worker edits the CSV and the person imports it back (File → Import).", unsupported: "Editing the live Google Sheet." },
        { id: "create", label: "Create new ones", adds: ["files", { change: "edit" }], know: "New spreadsheets are written as CSV files for the person to import into Google Sheets.", unsupported: "Creating sheets in Google Drive." }] },
    ] },

  { id: "wordpress", label: "WordPress", connector: false, workspace: "any",
    detect: ["wordpress", "wp-admin", "woocommerce"], absorbs: ["browser"], // "my WordPress website": its own question covers the browser
    why: "There's no WordPress connector: a worker can't sign in to WordPress or use its API, so it can't change posts, pages, media, plugins or settings on the live site.",
    questions: [
      { id: "site", type: "text", label: "Site address", placeholder: "https://…", knowledge: "WordPress site" },
      { id: "scope", type: "multi", label: "What part of the site?", required: true, choices: [
        { id: "content", label: "Posts, pages and media", adds: ["browser", {}], know: "It can open the site's public pages to read them.", unsupported: "Editing posts, pages or media in WordPress (needs the WordPress REST API with an application password)." },
        { id: "code", label: "Theme or plugin code", adds: ["code", { stack: "WordPress (PHP)" }], know: "The theme or plugin code is in the project folder (a Git checkout); the person deploys it." }] },
    ] },

  // Named often, not connected: recognised so the answer is honest rather than silent.
  ...[["notion", "Notion"], ["slack", "Slack"], ["gmail", "Gmail", "e-?mail|inbox"], ["airtable", "Airtable"], ["hubspot", "HubSpot"], ["salesforce", "Salesforce"],
    ["stripe", "Stripe"], ["jira", "Jira"], ["trello", "Trello"], ["webflow", "Webflow"], ["wix", "Wix"], ["squarespace", "Squarespace"], ["mailchimp", "Mailchimp"], ["whatsapp", "WhatsApp"]]
    .map(([id, label, extra]) => ({ id, label, connector: false, workspace: "any", detect: [id, ...(extra ? [extra] : [])], why: `There's no ${label} connector yet: a worker can't sign in to ${label} or read or change anything in it.`, questions: [] })),
];

const BY_ID = new Map(INTEGRATIONS.map((i) => [i.id, i]));
const rx = (src) => new RegExp(`(^|[^a-z0-9])(${src})(?=$|[^a-z0-9])`, "i");

// Checked once against the console's catalogues: a registry entry naming an unknown capability or
// requirement is a bug, and the console refuses to start rather than offer it.
export function checkRegistry(CAPABILITIES, RESOURCES) {
  for (const i of INTEGRATIONS) {
    const choices = (i.questions || []).flatMap((q) => q.choices || []);
    for (const c of [...(i.caps || []), ...choices.flatMap((ch) => ch.caps || [])]) if (!CAPABILITIES[c]) throw new Error(`integration ${i.id}: unknown capability ${c}`);
    for (const [r, a] of [...(i.reqs || []), ...choices.flatMap((ch) => ch.reqs || [])]) if (!RESOURCES[r]?.access[a]) throw new Error(`integration ${i.id}: unknown requirement ${r} ${a}`);
    for (const ch of choices) if (ch.adds && !BY_ID.get(ch.adds[0])?.connector) throw new Error(`integration ${i.id}: ${ch.id} adds ${ch.adds[0]}, which has no connector`);
  }
}

// What the page needs to show the registry: never functions or detection patterns.
export const publicRegistry = () => INTEGRATIONS.map((i) => ({ id: i.id, label: i.label, connector: i.connector, summary: i.summary || "", why: i.why || "",
  questions: (i.questions || []).map(({ prefill, ...q }) => ({ ...q, choices: q.choices?.map(({ id, label, help, unsupported, adds }) => ({ id, label, ...(help ? { help } : {}), ...(unsupported ? { unsupported } : {}), ...(adds ? { via: BY_ID.get(adds[0]).label } : {}) })) })) }));

// The integrations a description names, in registry order. A more specific one can absorb a generic
// match it already covers (WordPress asks itself whether to read the site in a browser).
export const detect = (text) => {
  const hit = INTEGRATIONS.filter((i) => i.detect.some((d) => rx(d).test(String(text || ""))));
  const absorbed = new Set(hit.flatMap((i) => i.absorbs || []));
  return hit.filter((i) => !absorbed.has(i.id)).map((i) => i.id);
};

class DraftError extends Error { constructor(m) { super(m); this.status = 400; } }
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const shown = (q, a) => !q.when || [].concat(a[q.when.q] ?? []).some((v) => q.when.is.includes(v));

// A draft from a request: { description, integrations?, answers?, others? }. Integrations default to
// what the description names. Everything is validated; capability lists sent by the page are never
// read. Returns the composed definition parts and what the page shows around them.
export function compose(req = {}) {
  const description = clip(req.description, 2000);
  if (!description) throw new DraftError("Describe what the worker should do.");
  const asked = req.integrations == null ? detect(description) : req.integrations;
  if (!Array.isArray(asked) || asked.length > 12) throw new DraftError("Integrations must be a list.");
  for (const id of asked) if (!BY_ID.has(id)) throw new DraftError(`"${id}" isn't an integration this platform knows. Name it under "Something else".`);
  const answersIn = req.answers && typeof req.answers === "object" && !Array.isArray(req.answers) ? req.answers : {};
  for (const [iid, a] of Object.entries(answersIn)) {
    const i = BY_ID.get(iid); if (!i) throw new DraftError(`"${iid}" isn't an integration this platform knows.`);
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new DraftError(`Answers for ${i.label} must be an object.`);
    for (const qid of Object.keys(a)) if (!i.questions.some((q) => q.id === qid && q.type !== "info")) throw new DraftError(`"${qid}" isn't a question for ${i.label}.`);
  }
  const others = (Array.isArray(req.others) ? req.others : []).map((s) => clip(s, 60)).filter(Boolean).slice(0, 5);

  const order = [...new Set(asked)], addedBy = {}, presets = {};
  const out = { caps: new Set(["files.read"]), reqs: [], steps: [], know: [], limits: [], approvals: [], unsupported: [], pending: [], starters: [] };
  const answers = {};
  const addReq = ([resource, access, need]) => { const k = out.reqs.find((r) => r.resource === resource && r.access === access); if (!k) out.reqs.push({ resource, access, need }); else if (need === "required") k.need = "required"; };
  for (let n = 0; n < order.length; n++) {
    const i = BY_ID.get(order[n]), given = answersIn[i.id] || {}, a = (answers[i.id] = {});
    if (!i.connector) out.unsupported.push({ id: i.id, label: i.label, why: i.why });
    (i.caps || []).forEach((c) => out.caps.add(c)); (i.reqs || []).forEach(addReq);
    out.steps.push(...(i.steps || [])); out.limits.push(...(i.limits || [])); out.starters.push(...(i.starters || []));
    for (const q of i.questions) {
      if (q.type === "info") continue;
      // A preset from the integration that brought this one in (a Shopify products CSV is editable).
      const fallback = presets[i.id]?.[q.id] ?? (q.type === "text" ? (q.prefill || []).find(([re]) => rx(re).test(description))?.[1] ?? "" : q.default);
      const v = given[q.id] !== undefined ? given[q.id] : fallback;
      if (!shown(q, a)) continue;
      if (q.type === "text") { a[q.id] = clip(v, 300); if (a[q.id] && q.knowledge) out.know.push(`${q.knowledge}: ${a[q.id]}`); continue; }
      const ids = q.type === "multi" ? (v == null ? [] : v) : v == null ? [] : [v];
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new DraftError(`Answer "${q.label}" with ${q.type === "multi" ? "a list of choices" : "one choice"}.`);
      if (q.type === "choice" && ids.length > 1) throw new DraftError(`Choose one answer for "${q.label}".`);
      for (const x of ids) if (!q.choices.some((c) => c.id === x)) throw new DraftError(`"${x}" isn't a choice for "${q.label}".`);
      a[q.id] = q.type === "multi" ? [...new Set(ids)] : ids[0] ?? null;
      if (!ids.length) { if (q.required) out.pending.push({ integration: i.id, question: q.id, label: `${i.label}: ${q.label}` }); continue; }
      for (const c of q.choices.filter((c) => ids.includes(c.id))) {
        (c.caps || []).forEach((x) => out.caps.add(x)); (c.reqs || []).forEach(addReq);
        out.limits.push(...(c.limits || [])); if (c.approval) out.approvals.push(`${i.label}: ${c.approval}`);
        if (c.know) out.know.push(c.know);
        if (c.unsupported) out.unsupported.push({ id: `${i.id}.${c.id}`, label: `${i.label}: ${c.label}`, why: c.unsupported });
        if (c.adds) { const [to, preset] = c.adds; presets[to] = { ...preset, ...presets[to] }; if (!order.includes(to)) { order.push(to); addedBy[to] = i.label; } }
      }
    }
  }
  for (const o of others) out.unsupported.push({ id: `other:${o}`, label: o, why: `There's no ${o} connector: a worker can't sign in to it or use it.` });
  const supported = order.filter((id) => BY_ID.get(id).connector);
  const first = BY_ID.get(supported[0]), asked0 = BY_ID.get(order[0]);
  // Named after what was asked for: a Shopify request is a "Shopify worker", even though today it
  // works through files and code.
  const name = !first ? "" : !asked0.connector ? `${asked0.label} worker` : supported.length === 1 ? first.name(answers[first.id] || {}) : `${first.short} and ${BY_ID.get(supported[1]).short} worker`;
  const via = order.filter((id) => !BY_ID.get(id).connector && !id.includes(".")).map((id) => BY_ID.get(id).label);
  const workspace = supported.some((id) => BY_ID.get(id).workspace === "project") ? "project" : "any";
  return {
    description, integrations: order, addedBy, answers, others, supported, workspace,
    pending: out.pending, unsupported: out.unsupported, approvals: out.approvals,
    nothingSupported: !supported.length,
    definition: {
      name,
      specialization: `${via.length ? `${via.join(", ")}, through: ` : ""}${supported.map((id) => BY_ID.get(id).specialization(answers[id] || {})).join("; ")}`,
      mission: description,
      capabilities: [...out.caps], requirements: out.reqs,
      workflow: ["Understand the request and what done means; ask one precise question if something essential is missing",
        "Check access to what the task needs; if something is missing, write NEEDS and stop", ...out.steps,
        "Check the result with the tools available", "Report what changed, what was checked, and what is left for the person"],
      knowledge: [`Set up from this request: "${description}"`, ...out.know, ...out.unsupported.map((u) => `Not possible here: ${u.label}. ${u.why}`)].join("\n"),
      limitations: [...new Set([...out.limits, "Never put secrets or credentials into files, logs or memory.", "Never say something was done or checked unless a tool result shows it."])],
      onMissing: "Say what is missing and exactly what the person has to do, in one or two plain sentences, then write NEEDS and stop.",
    },
    starters: [description, ...new Set(out.starters)].slice(0, 4),
  };
}
