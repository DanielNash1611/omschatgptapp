import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

test("actual MCP requests retain tool results and honor request opt-out without private payloads", async () => {
  const events: Record<string, unknown>[] = [];
  const sink = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    events.push(...JSON.parse(body)); res.end("{}");
  });
  sink.listen(0, "127.0.0.1"); await once(sink, "listening");
  const sinkPort = (sink.address() as {port:number}).port;
  const reserve = createPortServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as {port:number}).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "./mcp-server/node_modules/tsx/dist/loader.mjs", "--require", "./tests/analytics-fetch.cjs", "mcp-server/src/server.ts"], {
    stdio: "ignore", env: {...process.env, PORT:String(port), RENDER:"true", NODE_ENV:"production", IS_PULL_REQUEST:"false", DANIEL_ANALYTICS_DISABLED:"false", DANIEL_ANALYTICS_TEST_SINK:`http://127.0.0.1:${sinkPort}/`},
  });
  const client = new Client({name:"analytics-test",version:"1.0"});
  const optOut = new Client({name:"analytics-opt-out-test",version:"1.0"});
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const waitForEvents = async (count:number) => {
    for (let i=0; i<100 && events.length<count; i++) await delay(20);
    assert.equal(events.length,count);
  };
  try {
    let ready = false;
    for (let i=0; i<100; i++) {
      assert.equal(child.exitCode,null,"MCP test server exited");
      try { ready=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok; if(ready) break; } catch {}
      await delay(30);
    }
    assert.ok(ready);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const order = await client.callTool({name:"get_order_status",arguments:{orderId:"1002"}});
    assert.notEqual(order.isError,true); assert.match(JSON.stringify(order),/1002/);
    await waitForEvents(2);
    const failed = await client.callTool({name:"get_order_status_v2",arguments:{orderId:"private-unknown-order"}});
    assert.equal(failed.isError,true);
    await waitForEvents(4);
    await client.callTool({name:"debug_list_tools",arguments:{}});
    const prompted = await client.callTool({name:"cancel_order_v2",arguments:{orderId:"1002"}});
    assert.notEqual(prompted.isError,true);
    await waitForEvents(6);
    const cancelled = await client.callTool({name:"confirm_cancel_order_v2",arguments:{orderId:"1002",typedPhrase:"CANCEL 1002"}});
    assert.notEqual(cancelled.isError,true);
    await waitForEvents(8);
    await optOut.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{DNT:"1"}}}));
    const optedOutResult=await optOut.callTool({name:"get_order_status",arguments:{orderId:"1002"}});
    assert.notEqual(optedOutResult.isError,true); await delay(100); assert.equal(events.length,8);
    assert.equal(events.filter(e=>e.eventName==="tool_requested").length,4);
    assert.equal(events.filter(e=>e.eventName==="tool_completed").length,3);
    assert.equal(events.filter(e=>e.eventName==="tool_failed").length,1);
    assert.equal(new Set(events.map(e=>e.sessionId)).size,4);
    for(const event of events) {
      assert.equal(event.app,"omschatgptapp-mcp"); assert.deepEqual(event.properties,{});
      assert.deepEqual(Object.keys(event).sort(),["app","clientEventId","eventName","occurredAt","pagePath","properties","sessionId","visitorId"]);
    }
    assert.doesNotMatch(JSON.stringify(events),/1002|private-unknown-order|CANCEL|confirmationId|orderId/);
  } finally {
    await Promise.allSettled([client.close(),optOut.close()]);
    const stopped=once(child,"exit"); child.kill("SIGTERM"); await Promise.race([stopped,delay(3000)]);
    if(child.exitCode===null) child.kill("SIGKILL");
    await new Promise<void>(resolve=>sink.close(()=>resolve()));
  }
});
