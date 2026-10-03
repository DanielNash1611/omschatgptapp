// Test-only interception: synthetic hosted MCP calls cannot reach the real collector.
const target = new URL(process.env.DANIEL_ANALYTICS_TEST_SINK);
if (target.hostname !== "127.0.0.1") throw new Error("Analytics test sink must be loopback");
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => originalFetch(
  String(url) === "https://www.danielnash.co/api/analytics/events" ? target : url,
  options,
);
