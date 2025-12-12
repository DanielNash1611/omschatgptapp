/**
 * Minimal MCP-like JSON-RPC server (no @modelcontextprotocol/sdk available here).
 * Exposes OMS tools over POST /mcp with a simple JSON-RPC 2.0 contract.
 * Intended as scaffolding until the real MCP SDK can be used.
 */

import http from "http";
import { z } from "zod";
import { getOrderStatus } from "./oms";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

const PORT = Number(process.env.PORT) || 3002;
const PATH = "/mcp";

const getOrderStatusSchema = z.object({
  orderId: z.string().min(1)
});

const cancelOrderSchema = z.object({
  orderId: z.string().min(1)
});

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
};

const makeError = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcError => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, data }
});

const makeSuccess = (id: string | number | null, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result
});

const tools = {
  get_order_status: async (args: unknown) => {
    const parsed = getOrderStatusSchema.safeParse(args);
    if (!parsed.success) {
      throw makeError(null, -32602, "Invalid params", parsed.error.format());
    }
    const order = await getOrderStatus(parsed.data.orderId);
    if (!order) {
      return {
        name: "get_order_status",
        content: {
          orderId: parsed.data.orderId,
          status: "NOT_FOUND"
        }
      };
    }
    return {
      name: "get_order_status",
      content: {
        orderId: order.orderId,
        status: order.status,
        eta: order.eta,
        carrier: order.carrier,
        trackingNumber: order.trackingNumber,
        history: []
      }
    };
  },
  cancel_order: async (args: unknown) => {
    const parsed = cancelOrderSchema.safeParse(args);
    if (!parsed.success) {
      throw makeError(null, -32602, "Invalid params", parsed.error.format());
    }
    const result = await cancelOrder(parsed.data.orderId);
    return {
      name: "cancel_order",
      content: {
        orderId: parsed.data.orderId,
        ...result,
        cancelledAt: result.success ? new Date().toISOString() : undefined
      }
    };
  }
} as const;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== PATH) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", async () => {
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, makeError(null, -32700, "Parse error"));
    }

    const { id = null, method, params } = parsed;

    if (parsed.jsonrpc !== "2.0" || method !== "tools.call") {
      return sendJson(res, 400, makeError(id, -32600, "Invalid Request"));
    }

    const name = typeof params?.name === "string" ? params.name : null;
    const args = params?.arguments;

    if (!name || !(name in tools)) {
      return sendJson(res, 400, makeError(id, -32000, "Tool not found"));
    }

    try {
      const result = await tools[name as keyof typeof tools](args);
      return sendJson(res, 200, makeSuccess(id, result));
    } catch (error: unknown) {
      if (typeof error === "object" && error && "error" in (error as Record<string, unknown>)) {
        return sendJson(res, 400, error);
      }
      return sendJson(res, 500, makeError(id, -32603, "Internal error", String(error)));
    }
  });
});

server.listen(PORT, () => {
  console.log(`OMS MCP-like JSON-RPC server listening on http://localhost:${PORT}${PATH}`);
});
