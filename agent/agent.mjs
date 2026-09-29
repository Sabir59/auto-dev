// The AI half of the loop: Claude decides which Figma commands to run,
// via tool use, by talking to the bridge server over plain HTTP.
// This closes the roadmap item "let the AI inspect its own result and
// generate corrections" — the model is handed get_document_state and is
// expected to use it to check its own work.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node agent.mjs "your goal in plain English"

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const BRIDGE_URL = "http://localhost:8787/command";

async function sendCommand(type, params = {}) {
  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, params }),
  });
  // The bridge always returns JSON, including for its own errors
  // (503 no plugin connected, 504 timeout) — surface it to Claude as data
  // rather than throwing, so the model can see what went wrong and react.
  return res.json();
}

const tools = [
  betaZodTool({
    name: "create_frame",
    description: "Create a new frame (artboard) on the current Figma page.",
    inputSchema: z.object({
      width: z.number().describe("Frame width in px"),
      height: z.number().describe("Frame height in px"),
      name: z.string().describe("Frame name"),
    }),
    run: async (input) => sendCommand("CREATE_FRAME", input),
  }),

  betaZodTool({
    name: "create_text",
    description: "Create a text node on the current Figma page.",
    inputSchema: z.object({
      content: z.string().describe("The text to display"),
      x: z.number().optional().describe("X position, default 0"),
      y: z.number().optional().describe("Y position, default 0"),
      fontSize: z.number().optional().describe("Font size in px"),
    }),
    run: async (input) => sendCommand("CREATE_TEXT", input),
  }),

  betaZodTool({
    name: "modify_node",
    description:
      "Modify an existing node by its Figma node id: rename it, move/resize it, or change its fill color.",
    inputSchema: z.object({
      id: z.string().describe("Figma node id, from a previous tool result or get_document_state"),
      props: z.object({
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        fill: z
          .object({ r: z.number(), g: z.number(), b: z.number() })
          .describe("RGB color, each channel 0-1")
          .optional(),
      }),
    }),
    run: async (input) => sendCommand("MODIFY_NODE", input),
  }),

  betaZodTool({
    name: "get_document_state",
    description:
      "Read the top-level nodes currently on the Figma page (id, name, type, position, size). Use this to verify your own work before finishing, or to find a node's id before modifying it.",
    inputSchema: z.object({}),
    run: async () => sendCommand("GET_DOCUMENT_STATE"),
  }),
];

const SYSTEM_PROMPT = `You are operating a real, currently-open Figma file through a small \
set of tools. Each tool call performs a real edit — there is no simulation.

Work in this order:
1. Call get_document_state first to see what's already on the page.
2. Make the edits needed to satisfy the user's goal.
3. Call get_document_state again to verify the result actually matches the \
goal (right names, right content, right structure).
4. If something doesn't match, fix it with modify_node rather than leaving \
it wrong — this is the self-correction step, don't skip it.
5. Finish with a short plain-text summary of what you built and confirmed, \
including relevant node ids.`;

async function main() {
  const goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.error('Usage: node agent.mjs "<goal in plain English>"');
    process.exit(1);
  }

  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env

  console.log(`Goal: ${goal}\n`);

  const runner = client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools,
    messages: [{ role: "user", content: goal }],
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        console.log("[claude]", block.text);
      } else if (block.type === "tool_use") {
        console.log(`[tool_use] ${block.name}(${JSON.stringify(block.input)})`);
      }
    }
  }

  const final = await runner.done();
  console.log("\n--- done ---");
  console.log("stop_reason:", final.stop_reason);
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});
