import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cancelOrder, getOrderStatus } from "./oms.ts";
import type { CancelOrderResult, Order } from "./types.ts";

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

const httpServer = http.createServer(async (req, res) => {
  if (!req.url?.startsWith(PATH)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createServer();

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP server connection error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal server error");
    }
  } finally {
    await transport.close();
    await server.close();
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`OMS MCP server listening on http://${HOST}:${PORT}${PATH}`);
});
