#!/usr/bin/env node
// Builder.io adapter as an MCP server: native tools over Builder's documented HTTP APIs
// (builder-adapter/builder.mjs). No Builder MCP server, no model calls; the worker decides.
//
// BUILDER_ADAPTER_PROFILE=full registers every tool, including publish. =draft registers the
// drafting tools (create, update, upload) but never builder_publish_content, and the adapter
// itself additionally refuses live:true in that mode — so a draft-only worker has no path to a
// live write even if it tried, not merely an unregistered button. Anything else (unset included)
// is read-only: the write tools aren't registered at all, so an Inspect run can't call them
// whatever it's told. Writes are additionally refused unless the connected Space is marked as a
// test space (builder-adapter/builder.mjs).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { guardTools } from "./authz.mjs";
import { z } from "zod";
import * as B from "../builder-adapter/builder.mjs";

const FULL = process.env.BUILDER_ADAPTER_PROFILE === "full";
const DRAFT = process.env.BUILDER_ADAPTER_PROFILE === "draft";
const CAN_WRITE = FULL || DRAFT;
const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const NEEDS = "NEEDS: builder read: Builder API credentials for the target space are missing on this computer. Someone with access must add them once (builder-adapter/README.md). Stop and ask for them; don't try another way in.";
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.code === "NO_CREDENTIALS" ? NEEDS : e.code === "PRODUCTION_REFUSED" ? `${e.message} If this change is really wanted, ask the person; don't try another way.` : e.message }] });
const run = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const model = z.string().describe("Builder model name, e.g. page");
const id = z.string().describe("Builder content entry id");

const server = new McpServer({ name: "builder", version: "0.1.0" });
// Each tool call is checked with the console first when it runs this server for a worker (authz.mjs).
const BUILDER_READS = new Set(["builder_access_status", "builder_list_models", "builder_list_content", "builder_get_content", "builder_verify_content"]);
guardTools(server, (name) => (BUILDER_READS.has(name) ? "builder.read" : process.env.BUILDER_ADAPTER_PROFILE === "draft" ? "builder.write.draft" : "builder.write"));

server.registerTool("builder_access_status", {
  description: "Whether Builder credentials exist on this computer, which space they're for (its label and whether it's a test space), whether writes are allowed, and whether the key actually works. Call this before promising any Builder work.",
}, async () => {
  if (!B.credentialsPresent()) return ok({ connected: false, why: NEEDS });
  try { const s = B.accessSummary(); const models = await B.listModels(); return ok({ connected: true, ...s, models: models.length }); }
  catch (e) { return ok({ connected: false, why: e.message }); }
});

server.registerTool("builder_list_models", { description: "List the space's models (id, name, kind). Use the model name in the other tools." }, run(() => B.listModels()));

server.registerTool("builder_list_content", {
  description: "List entries of a model, drafts included, fresh (not from Builder's CDN cache): id, name, published state (draft/published/archived), url, timestamps.",
  inputSchema: { model, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), includeUnpublished: z.boolean().optional().describe("Default true; false lists only live content") },
}, run(({ model, limit, offset, includeUnpublished }) => B.listContent(model, { limit, offset, includeUnpublished })));

server.registerTool("builder_get_content", {
  description: "Read one entry by id, drafts included, fresh: its state and its data (and custom breakpoints, if set). draft:true reads its latest saved version, a pending draft included; otherwise the stored version.",
  inputSchema: { model, id, includeData: z.boolean().optional().describe("Default true"), draft: z.boolean().optional().describe("Read the latest saved version, pending draft included") },
}, run(async ({ model, id, includeData, draft }) => (await B.getContent(model, id, { includeData, draft })) ?? { found: false, why: `No entry ${id} in ${model} that this key can read.` }));

server.registerTool("builder_verify_content", {
  description: "Independently check an entry, bypassing the cache: its state, whether it's served as live at its url (a draft never is), and whether it has a pending draft (saved changes not live yet). Returns url (the live page) and previewUrl (the same path with Builder's preview parameters, which renders the latest saved version, pending draft included, on a site using the Builder SDK). Check either page with the browser tools; this tool doesn't.",
  inputSchema: { model, id },
}, run(({ model, id }) => B.verifyContent(model, id)));

if (CAN_WRITE) {
  server.registerTool("builder_create_draft", {
    description: "Create a new DRAFT entry (never published by this tool). Refused if an entry with the same name or url already exists in the model: update that one instead. Test spaces only.",
    inputSchema: { model, name: z.string(), data: z.record(z.string(), z.any()).optional().describe("The entry's data fields (for a page, e.g. title, blocks)"), url: z.string().optional().describe("For page models: the url path, e.g. /test-page") },
  }, run(({ model, name, data, url }) => B.createDraft(model, { name, data, url })));

  server.registerTool("builder_update_content", {
    description: "Change an existing entry by id: name and/or top-level data fields (each one given replaces that field; others stay), and optionally its custom breakpoints. Never creates an entry, never changes publication state. For a PUBLISHED entry choose draft:true (saved as a pending draft: the live page is unchanged until it's published; preview it at the returned previewUrl) or live:true (goes live now); without either it's refused. data can be read from a JSON file in your workspace (dataFile) instead of being passed inline. Test spaces only.",
    inputSchema: {
      model, id, name: z.string().optional(),
      data: z.record(z.string(), z.any()).optional().describe("Top-level data fields to set, e.g. { blocks: [...], title: ... }"),
      dataFile: z.string().optional().describe("Path, relative to your workspace, of a JSON file containing the data object (instead of data)"),
      breakpoints: z.object({ xsmall: z.number().int().optional(), small: z.number().int().optional(), medium: z.number().int().optional() }).strict().optional().describe("The page's responsive breakpoints in px (Builder's defaults: small 640, medium 991)"),
      draft: z.boolean().optional().describe("Save as a pending draft; the live page stays unchanged"),
      live: z.boolean().optional().describe("Apply to the live page now"),
    },
  }, run(({ model, id, name, data, dataFile, breakpoints, draft, live }) => B.updateContent(model, id, { name, data, dataFile, breakpoints, draft, live })));

  server.registerTool("builder_upload_asset", {
    description: "Upload an image or font file from your workspace to the space's asset library and get its public CDN url (to use in blocks, or in @font-face). Only files inside your workspace; images (png, jpg, webp, gif, svg) and fonts (ttf, otf, woff, woff2), up to 20 MB. Test spaces only.",
    inputSchema: { path: z.string().describe("Path relative to your workspace"), name: z.string().optional(), altText: z.string().optional() },
  }, run(({ path, name, altText }) => B.uploadAsset(path, { name, altText })));
}

// Publish is FULL-only: a draft-scoped worker never even has this tool, on top of the adapter's
// own refusal of live:true (builder-adapter/builder.mjs's assertPublishAllowed), so there are two
// independent layers between a draft-only run and a live write.
if (FULL) {
  server.registerTool("builder_publish_content", {
    description: "Publish an existing entry's latest saved version, a pending draft included (a bare published flag would discard the draft, so its content is written with it), then report what independent reads show: its state and whether it's served as live at its url. Builder's own response isn't treated as proof. Test spaces only.",
    inputSchema: { model, id },
  }, run(({ model, id }) => B.publishContent(model, id)));
}

await server.connect(new StdioServerTransport());
