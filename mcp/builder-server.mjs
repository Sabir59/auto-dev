#!/usr/bin/env node
// Builder.io adapter as an MCP server: native tools over Builder's documented HTTP APIs
// (builder-adapter/builder.mjs). No Builder MCP server, no model calls; the worker decides.
//
// BUILDER_ADAPTER_PROFILE=full registers every tool, including publish. =draft registers the
// drafting tools (create, update, upload) but never builder_publish_content, and the adapter
// itself additionally refuses live:true in that mode — so a draft-only worker has no path to a
// live write even if it tried, not merely an unregistered button. Anything else (unset included)
// is read-only: the write tools aren't registered at all, so an Inspect run can't call them
// whatever it's told.
//
// Spaces: run by a console, this server sees only the Builder spaces given to the worker, asked from
// its console at every call (builder-adapter/builder.mjs available()); it never gets the person's
// credential key, so it can't read any other space. A write is refused unless the worker was given
// write access to that space AND the space is marked as a test space, whatever tools are registered.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { guardTools } from "./authz.mjs";
import { z } from "zod";
import * as B from "../builder-adapter/builder.mjs";

const FULL = process.env.BUILDER_ADAPTER_PROFILE === "full";
const DRAFT = process.env.BUILDER_ADAPTER_PROFILE === "draft";
const CAN_WRITE = FULL || DRAFT;
const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const NEEDS = `NEEDS: builder read: ${B.NO_SPACE} Stop and ask for it; don't try another way in.`;
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.code === "NO_CREDENTIALS" ? NEEDS : e.code === "PRODUCTION_REFUSED" || e.code === "READ_ONLY_SPACE" ? `${e.message} If this change is really wanted, ask the person; don't try another way.` : e.message }] });
const run = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const model = z.string().describe("Builder model name, e.g. page");
const id = z.string().describe("Builder content entry id");
const space = z.string().optional().describe("Which Builder space (its id or name, from builder_access_status). Needed only when more than one space is available to you.");

const server = new McpServer({ name: "builder", version: "0.2.0" });
// Each tool call is checked with the console first when it runs this server for a worker (authz.mjs).
const BUILDER_READS = new Set(["builder_access_status", "builder_list_models", "builder_list_content", "builder_get_content", "builder_verify_content"]);
guardTools(server, (name) => (BUILDER_READS.has(name) ? "builder.read" : process.env.BUILDER_ADAPTER_PROFILE === "draft" ? "builder.write.draft" : "builder.write"));

server.registerTool("builder_access_status", {
  description: "The Builder spaces available to you: each one's id, name, whether it's a test or production space, whether you may write to it, and whether its keys work now. Call this before promising any Builder work, and use a space's id or name as space in the other tools when there's more than one.",
}, async () => {
  let spaces;
  try { spaces = await B.availableSpaces(); } catch (e) { return ok({ connected: false, why: e.code === "NO_CREDENTIALS" ? NEEDS : e.message }); }
  if (!spaces.length) return ok({ connected: false, why: NEEDS });
  const rows = await Promise.all(spaces.map(async (s) => {
    const row = { id: s.id, space: s.label, environment: s.environment, access: s.access, writes: s.access === "write" ? (CAN_WRITE ? "allowed (test space)" : "not in this run (read-only tools)") : s.environment === "test" ? "refused (you may only read it)" : "refused (production space)" };
    try { return { ...row, works: true, models: (await B.listModels({ space: s.id })).length }; } catch (e) { return { ...row, works: false, why: e.message }; }
  }));
  return ok({ connected: rows.some((r) => r.works), spaces: rows });
});

server.registerTool("builder_list_models", { description: "List a space's models (id, name, kind). Use the model name in the other tools.", inputSchema: { space } }, run(({ space }) => B.listModels({ space })));

server.registerTool("builder_list_content", {
  description: "List entries of a model, drafts included, fresh (not from Builder's CDN cache): id, name, published state (draft/published/archived), url, timestamps.",
  inputSchema: { model, space, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), includeUnpublished: z.boolean().optional().describe("Default true; false lists only live content") },
}, run(({ model, space, limit, offset, includeUnpublished }) => B.listContent(model, { space, limit, offset, includeUnpublished })));

server.registerTool("builder_get_content", {
  description: "Read one entry by id, drafts included, fresh: its state and its data (and custom breakpoints, if set). draft:true reads its latest saved version, a pending draft included; otherwise the stored version.",
  inputSchema: { model, id, space, includeData: z.boolean().optional().describe("Default true"), draft: z.boolean().optional().describe("Read the latest saved version, pending draft included") },
}, run(async ({ model, id, space, includeData, draft }) => (await B.getContent(model, id, { space, includeData, draft })) ?? { found: false, why: `No entry ${id} in ${model} that this key can read.` }));

server.registerTool("builder_verify_content", {
  description: "Independently check an entry, bypassing the cache: its state, whether it's served as live at its url (a draft never is), and whether it has a pending draft (saved changes not live yet). Returns url (the live page) and previewUrl (the same path with Builder's preview parameters, which renders the latest saved version, pending draft included, on a site using the Builder SDK). Check either page with the browser tools; this tool doesn't.",
  inputSchema: { model, id, space },
}, run(({ model, id, space }) => B.verifyContent(model, id, { space })));

if (CAN_WRITE) {
  server.registerTool("builder_create_draft", {
    description: "Create a new DRAFT entry (never published by this tool). Refused if an entry with the same name or url already exists in the model: update that one instead. Only in a space you may write to (a test space).",
    inputSchema: { model, space, name: z.string(), data: z.record(z.string(), z.any()).optional().describe("The entry's data fields (for a page, e.g. title, blocks)"), url: z.string().optional().describe("For page models: the url path, e.g. /test-page") },
  }, run(({ model, space, name, data, url }) => B.createDraft(model, { space, name, data, url })));

  server.registerTool("builder_update_content", {
    description: "Change an existing entry by id: name and/or top-level data fields (each one given replaces that field; others stay), and optionally its custom breakpoints. Never creates an entry, never changes publication state. For a PUBLISHED entry choose draft:true (saved as a pending draft: the live page is unchanged until it's published; preview it at the returned previewUrl) or live:true (goes live now); without either it's refused. data can be read from a JSON file in your workspace (dataFile) instead of being passed inline. Only in a space you may write to (a test space).",
    inputSchema: {
      model, id, space, name: z.string().optional(),
      data: z.record(z.string(), z.any()).optional().describe("Top-level data fields to set, e.g. { blocks: [...], title: ... }"),
      dataFile: z.string().optional().describe("Path, relative to your workspace, of a JSON file containing the data object (instead of data)"),
      breakpoints: z.object({ xsmall: z.number().int().optional(), small: z.number().int().optional(), medium: z.number().int().optional() }).strict().optional().describe("The page's responsive breakpoints in px (Builder's defaults: small 640, medium 991)"),
      draft: z.boolean().optional().describe("Save as a pending draft; the live page stays unchanged"),
      live: z.boolean().optional().describe("Apply to the live page now"),
    },
  }, run(({ model, id, space, name, data, dataFile, breakpoints, draft, live }) => B.updateContent(model, id, { space, name, data, dataFile, breakpoints, draft, live })));

  server.registerTool("builder_upload_asset", {
    description: "Upload an image or font file from your workspace to the space's asset library and get its public CDN url (to use in blocks, or in @font-face). Only files inside your workspace; images (png, jpg, webp, gif, svg) and fonts (ttf, otf, woff, woff2), up to 20 MB. Only in a space you may write to (a test space).",
    inputSchema: { path: z.string().describe("Path relative to your workspace"), space, name: z.string().optional(), altText: z.string().optional() },
  }, run(({ path, space, name, altText }) => B.uploadAsset(path, { space, name, altText })));
}

// Publish is FULL-only: a draft-scoped worker never even has this tool, on top of the adapter's
// own refusal of live:true (builder-adapter/builder.mjs's assertPublishAllowed), so there are two
// independent layers between a draft-only run and a live write.
if (FULL) {
  server.registerTool("builder_publish_content", {
    description: "Publish an existing entry's latest saved version, a pending draft included (a bare published flag would discard the draft, so its content is written with it), then report what independent reads show: its state and whether it's served as live at its url. Builder's own response isn't treated as proof. Only in a space you may write to (a test space).",
    inputSchema: { model, id, space },
  }, run(({ model, id, space }) => B.publishContent(model, id, { space })));
}

await server.connect(new StdioServerTransport());
