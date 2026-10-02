import test from "node:test";
import assert from "node:assert/strict";
import { withToolUsage } from "../mcp-server/src/analytics.js";

test("MCP usage excludes local, previews, opt-outs and disabled collection", async () => {
  const names = ["RENDER", "NODE_ENV", "IS_PULL_REQUEST", "DANIEL_ANALYTICS_DISABLED"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends++; return new Response(); };
  const result = { content: [{ type: "text" as const, text: "unchanged tool result" }] };
  try {
    Object.assign(process.env, { RENDER: "", NODE_ENV: "production", IS_PULL_REQUEST: "false", DANIEL_ANALYTICS_DISABLED: "false" });
    assert.equal(await withToolUsage(undefined, async () => result), result);
    process.env.RENDER = "true";
    for (const headers of [{dnt:"1"}, {"sec-gpc":["1"]}, {"x-daniel-analytics-disabled":"true"}]) {
      assert.equal(await withToolUsage(headers, async () => result), result);
    }
    process.env.IS_PULL_REQUEST = "true";
    await withToolUsage(undefined, async () => result);
    process.env.IS_PULL_REQUEST = "false";
    process.env.DANIEL_ANALYTICS_DISABLED = "true";
    await withToolUsage(undefined, async () => result);
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test("MCP counts independent tool requests without content, latency or result changes", async () => {
  const names = ["RENDER", "NODE_ENV", "IS_PULL_REQUEST", "DANIEL_ANALYTICS_DISABLED"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (_url, options) => {
    sent.push(JSON.parse(String(options?.body))[0]);
    return new Promise(() => {}); // Transport never resolves; the tool must still return.
  };
  const result = { content: [{ type: "text" as const, text: "private order details" }], _meta: { account: "private-account" } };
  try {
    Object.assign(process.env, { RENDER: "true", NODE_ENV: "production", IS_PULL_REQUEST: "false", DANIEL_ANALYTICS_DISABLED: "false" });
    assert.equal(await withToolUsage({authorization:"private-token"}, async () => result), result);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].eventName, "tool_requested");
    assert.equal(sent[1].eventName, "tool_completed");
    assert.equal(sent[0].sessionId, sent[1].sessionId);
    assert.ok(Date.parse(String(sent[1].occurredAt)) > Date.parse(String(sent[0].occurredAt)));
    assert.deepEqual(Object.keys(sent[0]).sort(), ["app", "clientEventId", "eventName", "occurredAt", "pagePath", "properties", "sessionId", "visitorId"]);
    assert.deepEqual(sent[0].properties, {});
    assert.equal(sent[0].app, "omschatgptapp-mcp");
    assert.doesNotMatch(JSON.stringify(sent), /private|account|authorization/);
    const failure = { content: [], isError: true };
    assert.equal(await withToolUsage(undefined, async () => failure), failure);
    assert.equal(sent[3].eventName, "tool_failed");
    assert.notEqual(sent[2].sessionId, sent[0].sessionId);
    const thrown = new Error("private tool error");
    globalThis.fetch = () => Promise.reject(new Error("private transport error"));
    await assert.rejects(withToolUsage(undefined, async () => { throw thrown; }), error => error === thrown);
    assert.equal(await withToolUsage(undefined, async () => result), result);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});
