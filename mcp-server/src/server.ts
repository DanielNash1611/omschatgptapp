import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cancelOrder, getOrderStatus } from "./oms.js";
import type { CancelOrderResult, Order } from "./types.js";

const PATH = "/mcp";
const PORT = Number(process.env.PORT ?? "8787");
const HOST = "0.0.0.0";

const orderIdParam = {
  orderId: z
    .string()
    .min(1, "orderId is required")
    .describe("The OMS order ID to look up or cancel."),
};

const createServer = () => {
  const server = new McpServer({
    name: "oms-mcp-server",
    version: "0.1.0",
  });

  server.tool(
    "get_order_status",
    orderIdParam,
    async ({ orderId }): Promise<CallToolResult> => {
      const order = await getOrderStatus(orderId);

      if (!order) {
        const text = `Order ${orderId} was not found in the OMS.`;
        return {
          structuredContent: toStructured({ orderId, status: "NOT_FOUND" }),
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }

      return {
        structuredContent: toStructured(order),
        content: [{ type: "text" as const, text: summarizeOrder(order) }],
      };
    }
  );

  server.tool(
    "cancel_order",
    orderIdParam,
    async ({ orderId }): Promise<CallToolResult> => {
      const result = await cancelOrder(orderId);

      const structuredContent = toStructured({ orderId, ...result });
      const text = result.success
        ? describeCancelled(orderId, result)
        : describeCancelFailure(orderId, result);

      return {
        structuredContent,
        content: [{ type: "text" as const, text }],
        isError: !result.success,
      };
    }
  );

  return server;
};

const summarizeOrder = (order: Order): string => {
  const parts = [
    `Order ${order.orderId} is ${order.status}.`,
    order.customerName ? `Customer: ${order.customerName}.` : "",
    order.eta ? `ETA: ${order.eta}.` : "",
    order.carrier ? `Carrier: ${order.carrier}.` : "",
    order.trackingNumber ? `Tracking: ${order.trackingNumber}.` : "",
    order.canCancel ? "Cancellable: yes." : "Cancellable: no.",
  ].filter(Boolean);

  return parts.join(" ");
};

const describeCancelled = (
  orderId: string,
  result: CancelOrderResult & { cancelledAt?: string }
): string => {
  const cancelledAt = result.cancelledAt ? ` at ${result.cancelledAt}` : "";
  return `Order ${orderId} has been cancelled${cancelledAt}.`;
};

const describeCancelFailure = (
  orderId: string,
  result: CancelOrderResult & { reason?: string; status?: string }
): string => {
  if (result.reason === "ORDER_NOT_FOUND") {
    return `Order ${orderId} was not found; nothing was cancelled.`;
  }
  if (result.reason === "NOT_CANCELLABLE") {
    return `Order ${orderId} cannot be cancelled while status is ${result.status ?? "unknown"}.`;
  }
  return `Order ${orderId} could not be cancelled.`;
};

const toStructured = (value: object): Record<string, unknown> =>
  ({ ...(value as Record<string, unknown>) });

const normalizeAcceptHeader = (req: IncomingMessage): void => {
  const raw = req.headers.accept;
  const accept = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  const hasJson = accept.includes("application/json");
  const hasSse = accept.includes("text/event-stream");

  if (!accept) {
    req.headers.accept = "application/json, text/event-stream";
  } else if (hasJson && !hasSse) {
    req.headers.accept = `${accept}, text/event-stream`;
  } else if (hasSse && !hasJson) {
    req.headers.accept = `${accept}, application/json`;
  } else if (Array.isArray(raw)) {
    req.headers.accept = accept;
  }
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions: Record<string, Session> = {};

const getSessionId = (req: IncomingMessage): string | undefined => {
  const header = req.headers["mcp-session-id"];
  if (Array.isArray(header)) return header[0];
  if (typeof header === "string") return header;
  return undefined;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
};

const handleInitializeRequest = async (
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> => {
  const server = createServer();
  let sessionIdForTransport: string | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sessionId => {
      sessionIdForTransport = sessionId;
      sessions[sessionId] = { transport, server };
    },
  });

  transport.onclose = () => {
    if (sessionIdForTransport) {
      delete sessions[sessionIdForTransport];
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res);
};

const handleExistingSession = async (
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string
): Promise<void> => {
  const session = sessions[sessionId];
  if (!session) {
    sendJson(res, 400, { error: "No valid session ID provided" });
    return;
  }
  await session.transport.handleRequest(req, res);
};

const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  normalizeAcceptHeader(req);

  const sessionId = getSessionId(req);

  if (!sessionId && req.method !== "POST") {
    sendJson(res, 400, { error: "Initialization must use POST /mcp" });
    return;
  }

  if (!sessionId) {
    await handleInitializeRequest(req, res);
    return;
  }

  await handleExistingSession(req, res, sessionId);
};

const server = createHttpServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Bad Request" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== PATH) {
    res.statusCode = 404;
    res.end();
    return;
  }

  try {
    await handleMcpRequest(req, res);
  } catch (error) {
    console.error("MCP server connection error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OMS MCP server listening on http://${HOST}:${PORT}${PATH}`);
});
