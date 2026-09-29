// Simulates the Figma plugin UI's WebSocket client, so we can verify the
// bridge server's request/response correlation without opening Figma.
// Not part of the POC deliverable — dev-only smoke test.
const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:8787/ws");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "__hello__", role: "plugin" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log("fake-plugin received:", msg);
  if (msg.type === "CREATE_FRAME") {
    ws.send(JSON.stringify({
      id: msg.id,
      ok: true,
      result: {
        id: "1:2",
        name: msg.params.name,
        width: msg.params.width,
        height: msg.params.height,
        summary: `SUCCESS: Created frame "${msg.params.name}", ${msg.params.width}x${msg.params.height}`,
      },
    }));
  } else if (msg.type === "PING") {
    ws.send(JSON.stringify({ id: msg.id, ok: true, result: { pong: true } }));
  }
});
