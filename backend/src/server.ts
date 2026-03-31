// Quickstart:
// 1. cd backend
// 2. npm install
// 3. Create a .env file with OPENAI_API_KEY=your_key_here
// 4. npm run dev
// 5. Backend listens on http://localhost:3001

import cors from "cors";
import type { CorsOptions } from "cors";
import dotenv from "dotenv";
import express from "express";
import { randomUUID } from "node:crypto";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { callAssistant } from "./openaiClient";
import { cancelOrder, getOrderStatus, mockOrders } from "./omsClient";
import { SYSTEM_PROMPT } from "./prompts";
import { Order } from "./types";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const MCP_URL = process.env.OMS_MCP_URL ?? "http://localhost:3002/mcp";
const DEV_DIAGNOSTICS =
  process.env.NODE_ENV !== "production" ||
  process.env.OMS_PROTOTYPE_DEV_DIAGNOSTICS === "true";
const ALLOW_MOCK_FALLBACK =
  process.env.NODE_ENV !== "production" ||
  process.env.OMS_PROTOTYPE_ALLOW_MOCK_FALLBACK === "true";
const AUTH_MODE = process.env.OMS_TOOL_AUTH_MODE ?? "none";
const AUTH_HEADER = (process.env.OMS_TOOL_AUTH_HEADER ?? "authorization").toLowerCase();
const AUTH_REQUIRED = process.env.OMS_TOOL_REQUIRE_AUTH === "true";
const TOOL_SCHEMAS = {
  get_order_status: {
    type: "object",
    properties: {
      orderId: { type: "string", minLength: 1 }
    },
    required: ["orderId"]
  }
} as const;

const allowedOrigins = [
  "http://localhost:5173",
  "https://omschatgptapp.vercel.app"
];
const vercelPreviewOrigin = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin) || vercelPreviewOrigin.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

const logDiagnostic = (...args: unknown[]) => {
  if (DEV_DIAGNOSTICS) {
    console.log(...args);
  }
};

type ToolError = {
  code: string;
  message: string;
  details?: unknown;
  nextActions?: string[];
};

const buildToolError = (code: string, message: string, details?: unknown): ToolError => ({
  code,
  message,
  details,
  nextActions: [
    "Verify the tool is registered in the app manifest or Actions config",
    "Restart the MCP server and backend",
    "Check OMS tool auth headers and tokens",
    "Confirm the request payload matches the schema (orderId string)"
  ]
});

const parseJwtExpiry = (token: string): number | null => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

const getAuthDiagnostics = (req: express.Request) => {
  const headerValue = req.get(AUTH_HEADER) ?? "";
  const token = headerValue.startsWith("Bearer ")
    ? headerValue.slice("Bearer ".length)
    : headerValue;
  const expiry = token ? parseJwtExpiry(token) : null;
  return {
    headerPresent: Boolean(headerValue),
    mode: AUTH_MODE,
    expiry
  };
};

const getMockFallback = (reason: string, requestId: string, originalOrderId: string) => {
  const fallbackOrder = mockOrders.find(order => order.orderId === "1002") ?? null;
  if (!fallbackOrder) return null;
  return {
    ...fallbackOrder,
    meta: {
      source: "mock_fallback",
      reason,
      requestId,
      originalOrderId
    },
    warning: `Mock fallback used due to ${reason}.`
  };
};

const isOrderLike = (value: unknown): value is Order =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { orderId?: unknown }).orderId === "string";

const buildOrderStub = (orderId: string): Order => ({
  orderId,
  status: "NOT_FOUND",
  customerName: "Unknown",
  carrier: null,
  trackingNumber: null,
  eta: null,
  canCancel: false,
  placedAt: null,
  shippingMethod: null,
  shippingAddress: null,
  payment: null,
  totals: null,
  items: [],
  cancelledAt: null
});

const buildOrderInquiryUi = (order: Order) => ({
  type: "order_inquiry_card",
  props: { order }
});

const decorateToolResult = (
  functionName: string,
  orderId: string | undefined,
  toolResult: unknown
): unknown => {
  if (functionName === "get_order_status") {
    const order = isOrderLike(toolResult)
      ? toolResult
      : buildOrderStub(orderId ?? "Unknown");

    return {
      ...(isOrderLike(toolResult) ? toolResult : order),
      found: isOrderLike(toolResult),
      reason: isOrderLike(toolResult) ? undefined : "ORDER_NOT_FOUND",
      ui: buildOrderInquiryUi(order)
    };
  }

  if (functionName === "cancel_order") {
    const base =
      typeof toolResult === "object" && toolResult !== null
        ? (toolResult as Record<string, unknown>)
        : {};
    const orderCandidate = "order" in base ? base.order : null;
    const resolvedOrderId =
      typeof base.orderId === "string" ? base.orderId : orderId ?? "Unknown";
    const order = isOrderLike(orderCandidate)
      ? orderCandidate
      : buildOrderStub(resolvedOrderId);

    return {
      ...base,
      order,
      ui: buildOrderInquiryUi(order)
    };
  }

  return toolResult;
};

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/tools/get_order_status", async (req, res) => {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";
  const authInfo = getAuthDiagnostics(req);

  logDiagnostic("[tools] get_order_status request", {
    requestId,
    orderId,
    authMode: authInfo.mode,
    authHeaderPresent: authInfo.headerPresent,
    authExpiry: authInfo.expiry,
    origin: req.get("origin"),
    userAgent: req.get("user-agent")
  });

  if (!orderId) {
    const error = buildToolError("SCHEMA_MISMATCH", "orderId is required");
    logDiagnostic("[tools] get_order_status schema mismatch", { requestId, error });
    return res.status(400).json({ error, requestId });
  }

  if (AUTH_REQUIRED && !authInfo.headerPresent) {
    const error = buildToolError(
      "AUTH_REQUIRED",
      "Connect/reauth OMS to use this tool."
    );
    logDiagnostic("[tools] get_order_status auth missing", { requestId, error });
    if (ALLOW_MOCK_FALLBACK) {
      const fallback = getMockFallback(error.code, requestId, orderId);
      if (fallback) {
        res.setHeader("x-oms-mock-fallback", "true");
        return res.status(200).json(fallback);
      }
    }
    return res.status(401).json({ error, requestId });
  }

  if (AUTH_REQUIRED && authInfo.expiry && authInfo.expiry < Date.now()) {
    const error = buildToolError("AUTH_EXPIRED", "OMS auth token expired.");
    logDiagnostic("[tools] get_order_status auth expired", { requestId, error });
    if (ALLOW_MOCK_FALLBACK) {
      const fallback = getMockFallback(error.code, requestId, orderId);
      if (fallback) {
        res.setHeader("x-oms-mock-fallback", "true");
        return res.status(200).json(fallback);
      }
    }
    return res.status(401).json({ error, requestId });
  }

  const rpcPayload = {
    jsonrpc: "2.0" as const,
    id: "backend-bridge",
    method: "tools.call",
    params: {
      name: "get_order_status",
      arguments: { orderId }
    }
  };

  try {
    const mcpResponse = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload)
    });

    if (!mcpResponse.ok) {
      const error = buildToolError("MCP_BAD_STATUS", "MCP bridge returned an error.", {
        status: mcpResponse.status
      });
      logDiagnostic("[tools] get_order_status MCP bad status", { requestId, error });
      if (ALLOW_MOCK_FALLBACK) {
        const fallback = getMockFallback(error.code, requestId, orderId);
        if (fallback) {
          res.setHeader("x-oms-mock-fallback", "true");
          return res.status(200).json(fallback);
        }
      }
      return res.status(502).json({ error, requestId });
    }

    let rpcJson: Record<string, unknown> | null = null;
    try {
      rpcJson = (await mcpResponse.json()) as Record<string, unknown>;
    } catch (parseError) {
      const error = buildToolError("MCP_BAD_RESPONSE", "Failed to parse MCP response.", parseError);
      logDiagnostic("[tools] get_order_status MCP parse error", { requestId, error });
      if (ALLOW_MOCK_FALLBACK) {
        const fallback = getMockFallback(error.code, requestId, orderId);
        if (fallback) {
          res.setHeader("x-oms-mock-fallback", "true");
          return res.status(200).json(fallback);
        }
      }
      return res.status(502).json({ error, requestId });
    }

    if (rpcJson?.error) {
      const rawMessage = (rpcJson.error as { message?: string })?.message;
      const message = typeof rawMessage === "string" ? rawMessage : "MCP tool error";
      const code = message.toLowerCase().includes("tool not found")
        ? "TOOL_NOT_REGISTERED"
        : "MCP_TOOL_ERROR";
      const error = buildToolError(code, message, rpcJson.error);
      logDiagnostic("[tools] get_order_status MCP tool error", { requestId, error });
      if (ALLOW_MOCK_FALLBACK) {
        const fallback = getMockFallback(error.code, requestId, orderId);
        if (fallback) {
          res.setHeader("x-oms-mock-fallback", "true");
          return res.status(200).json(fallback);
        }
      }
      return res.status(500).json({ error, requestId });
    }

    const result = rpcJson?.result as Record<string, unknown> | undefined;
    const content =
      (result?.content as Record<string, unknown> | undefined) ??
      (result?.structuredContent as Record<string, unknown> | undefined) ??
      {};
    if (!content || typeof content !== "object") {
      const error = buildToolError("SCHEMA_MISMATCH", "Unexpected MCP response shape.", rpcJson);
      logDiagnostic("[tools] get_order_status schema mismatch", { requestId, error });
      if (ALLOW_MOCK_FALLBACK) {
        const fallback = getMockFallback(error.code, requestId, orderId);
        if (fallback) {
          res.setHeader("x-oms-mock-fallback", "true");
          return res.status(200).json(fallback);
        }
      }
      return res.status(502).json({ error, requestId });
    }

    const clean: Order = {
      orderId: (content as { orderId?: string }).orderId ?? orderId,
      status: (content as { status?: string }).status ?? "UNKNOWN",
      eta: (content as { eta?: string | null }).eta ?? null,
      carrier: (content as { carrier?: string | null }).carrier ?? null,
      trackingNumber: (content as { trackingNumber?: string | null }).trackingNumber ?? null,
      canCancel: (content as { canCancel?: boolean }).canCancel ?? false,
      customerName: (content as { customerName?: string }).customerName ?? "Unknown",
      placedAt: (content as { placedAt?: string | null }).placedAt ?? null,
      shippingMethod: (content as { shippingMethod?: string | null }).shippingMethod ?? null,
      shippingAddress: (content as { shippingAddress?: Order["shippingAddress"] | null })
        .shippingAddress ?? null,
      payment: (content as { payment?: Order["payment"] | null }).payment ?? null,
      totals: (content as { totals?: Order["totals"] | null }).totals ?? null,
      items: (content as { items?: Order["items"] }).items ?? []
    };

    return res.json(clean);
  } catch (error: unknown) {
    console.error("Error in /api/tools/get_order_status:", error);
    const toolError = buildToolError("MCP_UNREACHABLE", "Unable to reach MCP server.", String(error));
    logDiagnostic("[tools] get_order_status MCP unreachable", { requestId, error: toolError });
    if (ALLOW_MOCK_FALLBACK) {
      const fallback = getMockFallback(toolError.code, requestId, orderId);
      if (fallback) {
        res.setHeader("x-oms-mock-fallback", "true");
        return res.status(200).json(fallback);
      }
    }
    return res.status(500).json({
      error: toolError,
      requestId
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const userMessage: string | undefined = req.body?.message;

  if (!userMessage || typeof userMessage !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];

  try {
    const firstResponse = await callAssistant(messages);
    const firstMessage = firstResponse.choices[0]?.message;

    if (firstMessage?.tool_calls && firstMessage.tool_calls.length > 0) {
      messages.push(firstMessage as ChatCompletionMessageParam);

      const toolCall = firstMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      let parsedArgs: Record<string, string> = {};

      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }

      let toolResult: unknown = null;
      let debugAction: string | undefined;
      let debugOrderId: string | undefined;

      if (functionName === "get_order_status") {
        debugAction = "get_order_status";
        debugOrderId = parsedArgs.orderId;
        toolResult = parsedArgs.orderId
          ? await getOrderStatus(parsedArgs.orderId)
          : { error: "orderId missing" };
      } else if (functionName === "cancel_order") {
        debugAction = "cancel_order";
        debugOrderId = parsedArgs.orderId;
        toolResult = parsedArgs.orderId
          ? await cancelOrder(parsedArgs.orderId)
          : { error: "orderId missing" };
      }

      const decoratedToolResult = decorateToolResult(
        functionName,
        debugOrderId,
        toolResult
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(decoratedToolResult)
      });

      const secondResponse = await callAssistant(messages);
      const finalMessage = secondResponse.choices[0]?.message;
      let finalText = "";
      if (typeof finalMessage?.content === "string") {
        finalText = finalMessage.content;
      } else if (Array.isArray(finalMessage?.content)) {
        const parts: unknown[] = finalMessage.content;
        finalText = parts
          .map((chunk: unknown): string => {
            if (typeof chunk === "string") return chunk;
            if (chunk && typeof chunk === "object" && "text" in (chunk as { text?: string })) {
              const maybeText = (chunk as { text?: string }).text;
              if (typeof maybeText === "string") return maybeText;
            }
            return (chunk as { toString?: () => string })?.toString?.() ?? "";
          })
          .join("");
      }

      return res.json({
        assistantMessage: finalText,
        toolName: debugAction,
        toolResult: decoratedToolResult,
        debug: {
          action: debugAction,
          orderId: debugOrderId,
          toolResult: decoratedToolResult
        }
      });
    }

    const assistantText =
      typeof firstMessage?.content === "string"
        ? firstMessage.content
        : "I didn't get that. Can you rephrase?";

    return res.json({ assistantMessage: assistantText });
  } catch (error: unknown) {
    console.error("Error in /api/chat:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", details: String(error) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OMS assistant backend listening on http://0.0.0.0:${PORT}`);
  logDiagnostic("[tools] MCP bridge target", MCP_URL);
  logDiagnostic("[tools] auth mode", {
    mode: AUTH_MODE,
    required: AUTH_REQUIRED,
    header: AUTH_HEADER
  });
  logDiagnostic("[tools] registered tool schemas", TOOL_SCHEMAS);
});
