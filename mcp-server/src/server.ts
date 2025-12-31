import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";
import { cancelOrder, getOrderStatus } from "./oms.js";
import type { CancelOrderResult, Order } from "./types.js";

const PATH = "/mcp";
const PORT = Number(process.env.PORT ?? "8787");
const HOST = "0.0.0.0";
const app = express();
app.use(express.json({ limit: "1mb" }));

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

const normalizeAcceptHeader = (req: { headers: Request["headers"] }): void => {
  const accept = req.headers.accept ?? "";
  const hasJson = accept.includes("application/json");
  const hasSse = accept.includes("text/event-stream");

  if (!accept) {
    req.headers.accept = "application/json, text/event-stream";
  } else if (hasJson && !hasSse) {
    req.headers.accept = `${accept}, text/event-stream`;
  } else if (hasSse && !hasJson) {
    req.headers.accept = `${accept}, application/json`;
  }
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions: Record<string, Session> = {};

const getSessionId = (req: Request): string | undefined => {
  const header = req.headers["mcp-session-id"];
  if (Array.isArray(header)) return header[0];
  if (typeof header === "string") return header;
  return undefined;
};

const acceptNormalizer = (req: Request, _res: Response, next: NextFunction) => {
  normalizeAcceptHeader(req);
  next();
};

app.use(PATH, acceptNormalizer);

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post(PATH, async (req: Request, res: Response) => {
  try {
    if (isInitializeRequest(req.body)) {
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
      return;
    }

    const sessionId = getSessionId(req);
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({ error: "No valid session ID provided" });
      return;
    }

    const session = sessions[sessionId];
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP server connection error:", error);
    if (!res.headersSent) {
      res.status(500).end("Internal server error");
    }
  }
});

app.get(PATH, async (req: Request, res: Response) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({ error: "No valid session ID provided" });
      return;
    }
    const session = sessions[sessionId];
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP server connection error:", error);
    if (!res.headersSent) {
      res.status(500).end("Internal server error");
    }
  }
});

app.listen(PORT, HOST, () => {
  console.log(`OMS MCP server listening on http://${HOST}:${PORT}${PATH}`);
});
