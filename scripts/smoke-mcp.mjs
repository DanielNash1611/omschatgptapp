import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
const port = 4321;
const child = spawn(process.execPath, ["mcp-server/dist/server.js"], { stdio: "inherit", env: { ...process.env, PORT: String(port) } });
const client = new Client({ name: "maintenance-smoke", version: "1.0.0" });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("MCP server exited");
    try { await fetch(`http://127.0.0.1:${port}/`); ready = true; break; } catch {}
    await delay(100);
  }
  assert.ok(ready);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === "get_order_status"));
  assert.ok(tools.some(tool => tool.name === "cancel_order"));
  const order = await client.callTool({ name: "get_order_status", arguments: { orderId: "1002" } });
  assert.notEqual(order.isError, true);
  assert.match(JSON.stringify(order), /1002/);
  const resource = await client.readResource({ uri: "ui://widget/oms-order-v2.html" });
  assert.ok(resource.contents.some(item => item.mimeType?.includes("html")));
  console.log("Built MCP initialize, tools, mock lookup and widget resource smoke passed");
} finally {
  await client.close();
  const stopped = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([stopped, delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
