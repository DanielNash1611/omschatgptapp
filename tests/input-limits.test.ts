import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { INPUT_LIMITS, assertInputBudget } from "../mcp-server/src/inputLimits.js";

test("input complexity boundaries", () => {
  assertInputBudget({ orderId: "1002", typedPhrase: "CANCEL 1002" });
  assertInputBudget(Array(INPUT_LIMITS.elements).fill(0));
  assert.throws(() => assertInputBudget(Array(INPUT_LIMITS.elements + 1).fill(0)));
  assertInputBudget("x".repeat(INPUT_LIMITS.string));
  assert.throws(() => assertInputBudget("x".repeat(INPUT_LIMITS.string + 1)));
  assert.throws(() => assertInputBudget({ ["x".repeat(INPUT_LIMITS.string + 1)]: 0 }));
  let value: unknown = 0;
  for (let i = 0; i < INPUT_LIMITS.depth; i++) value = { x: value };
  assertInputBudget(value);
  assert.throws(() => assertInputBudget({ x: value }));
});

for (const entry of ["server", "index"]) {
  test(`${entry} HTTP parser rejects oversized and malformed requests before tool effects`, async () => {
    const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    const child = spawn(process.execPath, ["--import", "./mcp-server/node_modules/tsx/dist/loader.mjs", `mcp-server/src/${entry}.ts`], { stdio: "ignore", env: { PATH: process.env.PATH, PORT: String(port), DANIEL_ANALYTICS_DISABLED: "true" } });
    const url = `http://127.0.0.1:${port}/mcp`;
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        assert.equal(child.exitCode, null, "test server exited");
        try { await fetch(url); ready = true; break; } catch {}
        await delay(25);
      }
      assert.ok(ready);
      const post = (body: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
      const cases: Array<[string, number, Record<string, string>?]> = [
        ["{", 400], ["null", 400], ["{}" + " ".repeat(INPUT_LIMITS.bytes), 413],
        [JSON.stringify({ unknown: Array(INPUT_LIMITS.elements + 1).fill(0) }), 413],
        [JSON.stringify({ unknown: "x".repeat(INPUT_LIMITS.string + 1) }), 413],
        ["{}", 415, { "content-type": "text/plain" }], ["{}", 415, { "content-encoding": "br" }]
      ];
      for (const [body, status, headers] of cases) assert.equal((await post(body, headers)).status, status);
      const chunkedStatus = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject);
        req.write("{}" + " ".repeat(INPUT_LIMITS.bytes - 2));
        req.end(" ");
      });
      assert.equal(chunkedStatus, 413);
      const valid = JSON.stringify(entry === "server" ? { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } } : { jsonrpc: "2.0", id: 1, method: "tools.call", params: { name: "get_order_status", arguments: { orderId: "1002" } } });
      const response = await post(valid + " ".repeat(INPUT_LIMITS.bytes - Buffer.byteLength(valid)));
      assert.equal(response.status, 200, "exact byte limit and normal request after rejection");
      assert.match(await response.text(), entry === "server" ? /oms-mcp-server/ : /1002/);
    } finally {
      const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped;
    }
  });
}
