import { randomUUID } from "node:crypto";
import type { CallToolResult, IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";

type UsageEvent = "tool_requested" | "tool_completed" | "tool_failed";

// Read only opt-out flags. Never inspect MCP arguments, account IDs or transport IDs.
function optedOut(headers?: IsomorphicHeaders): boolean {
  const matches = (name: string, expected: string) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value.includes(expected) : value === expected;
  };
  return matches("dnt", "1") || matches("sec-gpc", "1") ||
    matches("x-daniel-analytics-disabled", "true");
}

function recorder(headers?: IsomorphicHeaders) {
  if (process.env.DANIEL_ANALYTICS_DISABLED === "true" || optedOut(headers) ||
      process.env.RENDER !== "true" || process.env.NODE_ENV !== "production" ||
      process.env.IS_PULL_REQUEST === "true") return undefined;
  const sessionId = "session_" + randomUUID();
  const visitorId = "visitor_" + randomUUID();
  let lastTimestamp = Date.now() - 1;
  return (eventName: UsageEvent) => {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    const body = JSON.stringify([{
      app: "omschatgptapp-mcp", eventName, clientEventId: randomUUID(),
      sessionId, visitorId, pagePath: "/", properties: {},
      occurredAt: new Date(lastTimestamp).toISOString(),
    }]);
    try {
      // The persistent Render process delivers in the background; tools never await analytics.
      void fetch("https://www.danielnash.co/api/analytics/events", {
        method: "POST", headers: {
          Origin: "https://omschatgptapp.vercel.app", "Content-Type": "text/plain;charset=UTF-8",
        }, body, signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    } catch { /* Preserve tool behavior without logging payloads or transport errors. */ }
  };
}

export async function withToolUsage<T extends CallToolResult>(
  headers: IsomorphicHeaders | undefined, run: () => Promise<T>,
): Promise<T> {
  const record = recorder(headers);
  record?.("tool_requested");
  try {
    const result = await run();
    record?.(result.isError ? "tool_failed" : "tool_completed");
    return result;
  } catch (error) {
    record?.("tool_failed");
    throw error;
  }
}
