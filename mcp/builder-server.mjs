#!/usr/bin/env node
// Builder.io adapter as an MCP server: native tools over Builder's documented HTTP APIs
// (builder-adapter/builder.mjs). No Builder MCP server, no model calls; the worker decides.
//
// BUILDER_ADAPTER_PROFILE=full registers every tool. Anything else (unset included) is read-only:
// the write tools aren't registered at all, so an Inspect run can't call them whatever it's told.
// Writes are additionally refused unless the connected Space is marked as a test space.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as B from "../builder-adapter/builder.mjs";

const FULL = process.env.BUILDER_ADAPTER_PROFILE === "full";
const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const NEEDS = "NEEDS: builder read: Builder API credentials for the target space are missing on this computer. Someone with access must add them once (builder-adapter/README.md). Stop and ask for them; don't try another way in.";
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.code === "NO_CREDENTIALS" ? NEEDS : e.code === "PRODUCTION_REFUSED" ? `${e.message} If this change is really wanted, ask the person; don't try another way.` : e.message }] });
const run = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const model = z.string().describe("Builder model name, e.g. page");
const id = z.string().describe("Builder content entry id");

const server = new McpServer({ name: "builder", version: "0.1.0" });

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
  description: "Read one entry by id, drafts included, fresh: its state and its data.",
  inputSchema: { model, id, includeData: z.boolean().optional().describe("Default true") },
}, run(async ({ model, id, includeData }) => (await B.getContent(model, id, { includeData })) ?? { found: false, why: `No entry ${id} in ${model} that this key can read.` }));

server.registerTool("builder_verify_content", {
  description: "Independently check an entry's publication: its state (with drafts) and whether the public Content API serves it as live content, both bypassing the cache. Returns its url so the page itself can be checked in the browser (browser tools), which this tool doesn't do.",
  inputSchema: { model, id },
}, run(({ model, id }) => B.verifyContent(model, id)));

if (FULL) {
  server.registerTool("builder_create_draft", {
    description: "Create a new DRAFT entry (never published by this tool). Refused if an entry with the same name or url already exists in the model: update that one instead. Test spaces only.",
    inputSchema: { model, name: z.string(), data: z.record(z.string(), z.any()).optional().describe("The entry's data fields (for a page, e.g. title, blocks)"), url: z.string().optional().describe("For page models: the url path, e.g. /test-page") },
  }, run(({ model, name, data, url }) => B.createDraft(model, { name, data, url })));

  server.registerTool("builder_update_content", {
    description: "Change an existing entry by id (name and/or data fields; PATCH, so other fields stay). Never creates an entry, never changes publication state. Changing a PUBLISHED entry goes live immediately, so it's refused unless live:true. Test spaces only.",
    inputSchema: { model, id, name: z.string().optional(), data: z.record(z.string(), z.any()).optional(), live: z.boolean().optional().describe("Required to change an entry that is already published") },
  }, run(({ model, id, name, data, live }) => B.updateContent(model, id, { name, data, live })));

  server.registerTool("builder_publish_content", {
    description: "Publish an existing entry (Write API, published: \"published\"), then report what independent reads show: its state and whether the public Content API serves it. Builder's own response isn't treated as proof. Test spaces only.",
    inputSchema: { model, id },
  }, run(({ model, id }) => B.publishContent(model, id)));
}

await server.connect(new StdioServerTransport());
