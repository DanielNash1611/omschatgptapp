import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cancelOrder, getOrderStatus } from "./oms.js";
import type { CancelOrderResult, Order } from "./types.js";

const PATH = "/mcp";
const PORT = Number(process.env.PORT ?? "8787");
const HOST = "0.0.0.0";
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const UI_RESOURCE_URI = "ui://widget/oms-order-v2.html";
const WIDGET_MIME_TYPE = "text/html+skybridge";
const WIDGET_ASSET_ROUTE = "/widget-assets/";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIDGET_DIST_DIR = resolve(REPO_ROOT, "frontend", "dist");
const WIDGET_ASSET_DIR = resolve(WIDGET_DIST_DIR, "assets");
const WIDGET_HTML_PATH = resolve(WIDGET_DIST_DIR, "widget.html");
const ensureTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;
const WIDGET_ASSET_BASE_URL = ensureTrailingSlash(
  process.env.OMS_WIDGET_ASSET_BASE_URL ??
    `http://localhost:${PORT}${WIDGET_ASSET_ROUTE}`
);
const TOOL_OUTPUT_TEMPLATE_META = {
  "openai/outputTemplate": UI_RESOURCE_URI,
} as const;
const TOOL_WIDGET_ACCESS_META = {
  "openai/widgetAccessible": true,
} as const;
const TOOL_WIDGET_TEMPLATE_META = {
  ...TOOL_OUTPUT_TEMPLATE_META,
  ...TOOL_WIDGET_ACCESS_META,
} as const;
const WIDGET_ASSET_MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "application/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const orderIdParam = {
  orderId: z
    .string()
    .min(1, "orderId is required")
    .describe("The OMS order ID to look up or cancel."),
};

const cancelOrderParams = {
  orderId: z
    .string()
    .min(1, "orderId is required")
    .describe("The OMS order ID to cancel."),
  confirmationId: z
    .string()
    .optional()
    .describe("Echoed confirmation ID required to finalize cancellation."),
  typedPhrase: z
    .string()
    .optional()
    .describe("User-entered phrase matching `CANCEL <orderId>` required to finalize cancellation."),
};
const orderIdSchema = z.object(orderIdParam);
const cancelOrderSchema = z.object(cancelOrderParams);

const pendingConfirmations: Record<string, { orderId: string; expiresAt: number }> = {};

type WidgetHtmlResult = {
  html: string;
  source: "dist" | "fallback";
  bytes: number;
};

const buildWidgetHtml = async (): Promise<WidgetHtmlResult> => {
  try {
    const raw = await readFile(WIDGET_HTML_PATH, "utf-8");
    const html = raw.replace(/(src|href)=["']\/assets\//g, `$1="${WIDGET_ASSET_BASE_URL}`);
    return { html, source: "dist", bytes: Buffer.byteLength(html) };
  } catch (error) {
    console.error("[mcp] widget html unavailable", {
      path: WIDGET_HTML_PATH,
      error: String(error),
    });
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OMS Widget</title>
  </head>
  <body>
    <div>Widget bundle not found. Build the frontend or set OMS_WIDGET_ASSET_BASE_URL.</div>
  </body>
</html>`;
    return { html, source: "fallback", bytes: Buffer.byteLength(html) };
  }
};

const registerWidgetResource = (server: McpServer): void => {
  server.registerResource(
    "oms_order_widget",
    UI_RESOURCE_URI,
    {
      title: "OMS Order Widget",
      mimeType: WIDGET_MIME_TYPE,
      description: "OMS order widget template for ChatGPT Apps.",
    },
    async () => {
      console.log("[MCP] widget resource requested:", UI_RESOURCE_URI);
      const result = await buildWidgetHtml();
      console.log("[MCP] widget html served", {
        source: result.source,
        bytes: result.bytes,
      });
      return {
        contents: [
          {
            uri: UI_RESOURCE_URI,
            mimeType: WIDGET_MIME_TYPE,
            text: result.html,
          },
        ],
      };
    }
  );
};

const resolveWidgetAssetPath = (pathname: string): string | null => {
  if (!pathname.startsWith(WIDGET_ASSET_ROUTE)) return null;
  const relative = pathname.slice(WIDGET_ASSET_ROUTE.length);
  if (!relative) return null;
  const safeRelative = normalize(relative).replace(/^(\.\.[\\/])+/, "");
  const fullPath = resolve(WIDGET_ASSET_DIR, safeRelative);
  if (!fullPath.startsWith(WIDGET_ASSET_DIR)) return null;
  return fullPath;
};

const serveWidgetAsset = async (
  pathname: string,
  res: ServerResponse
): Promise<boolean> => {
  console.log("[MCP] widget asset request:", pathname);
  const assetPath = resolveWidgetAssetPath(pathname);
  if (!assetPath) {
    console.warn("[MCP] widget asset invalid path:", pathname);
    res.statusCode = 404;
    res.end();
    return true;
  }
  try {
    const data = await readFile(assetPath);
    const ext = extname(assetPath).toLowerCase();
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      WIDGET_ASSET_MIME_TYPES[ext] ?? "application/octet-stream"
    );
    res.setHeader("Content-Length", data.length);
    res.end(data);
    console.log("[MCP] widget asset served:", pathname, data.length);
  } catch (error) {
    console.warn("[MCP] widget asset 404:", pathname);
    res.statusCode = 404;
    res.end();
  }
  return true;
};

const createServer = () => {
  const server = new McpServer({
    name: "oms-mcp-server",
    version: "0.1.0",
  });

  registerWidgetResource(server);
  console.log("[MCP] widget resource registered:", UI_RESOURCE_URI, WIDGET_MIME_TYPE);

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description: "Look up the status and details for an OMS order.",
      inputSchema: orderIdSchema,
      _meta: TOOL_OUTPUT_TEMPLATE_META,
    },
    async ({ orderId }) => handleOrderInquiry(orderId)
  );
  server.registerTool(
    "order_inquiry",
    {
      title: "Order inquiry",
      description: "Alias for get_order_status.",
      inputSchema: orderIdSchema,
      _meta: TOOL_OUTPUT_TEMPLATE_META,
    },
    async ({ orderId }) => handleOrderInquiry(orderId)
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Request or confirm an OMS order cancellation.",
      inputSchema: cancelOrderSchema,
      _meta: TOOL_WIDGET_TEMPLATE_META,
    },
    async ({ orderId, confirmationId, typedPhrase }) =>
      handleOrderCancel({ orderId, confirmationId, typedPhrase })
  );
  server.registerTool(
    "order_cancel",
    {
      title: "Order cancel",
      description: "Alias for cancel_order.",
      inputSchema: cancelOrderSchema,
      _meta: TOOL_WIDGET_TEMPLATE_META,
    },
    async ({ orderId, confirmationId, typedPhrase }) =>
      handleOrderCancel({ orderId, confirmationId, typedPhrase })
  );

  return server;
};

const requiredPhraseFor = (orderId: string): string => `CANCEL ${orderId}`;

const formatCurrency = (amount?: number | null, currency = "USD"): string => {
  if (typeof amount !== "number") return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
};

const formatDateTime = (value?: string | null): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const itemCount = (order?: Order | null): number =>
  order?.items?.reduce((sum, item) => sum + (item.quantity ?? 0), 0) ?? 0;

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
  cancelledAt: null,
});

const buildOrderInquiryUi = (order: Order): Record<string, unknown> => ({
  type: "order_inquiry_card",
  props: { order },
});

const buildCancelConfirmUi = (
  order: Order,
  confirmationId: string,
  expiresAt: string,
  requiredPhrase: string,
  errorMessage?: string
): Record<string, unknown> => ({
  type: "cancel_confirm",
  props: {
    order,
    orderSummary: {
      orderId: order.orderId,
      status: order.status,
      itemCount: itemCount(order),
      total: order.totals?.total ?? null,
      currency: order.totals?.currency ?? "USD",
    },
    confirmationId,
    requiredPhrase,
    expiresAt,
    warning: "Cancellation cannot be undone.",
    errorMessage,
  },
});

const handleOrderInquiry = async (orderId: string): Promise<CallToolResult> => {
  const order = await getOrderStatus(orderId);

  if (!order) {
    const text = `Order ${orderId} was not found in the OMS.`;
    const stub = buildOrderStub(orderId);
    return {
      structuredContent: toStructured({ orderId, status: "NOT_FOUND" }),
      content: [{ type: "text" as const, text }],
      ui: buildOrderInquiryUi(stub),
      isError: true,
    };
  }

  return {
    structuredContent: toStructured({ order }),
    content: [{ type: "text" as const, text: summarizeOrder(order) }],
    ui: buildOrderInquiryUi(order),
  };
};

type CancelOrderArgs = {
  orderId: string;
  confirmationId?: string;
  typedPhrase?: string;
};

const handleOrderCancel = async ({
  orderId,
  confirmationId,
  typedPhrase,
}: CancelOrderArgs): Promise<CallToolResult> => {
  const order = await getOrderStatus(orderId);
  if (!order) {
    const text = `Order ${orderId} was not found; nothing was cancelled.`;
    return {
      structuredContent: toStructured({ orderId, success: false, reason: "ORDER_NOT_FOUND" }),
      content: [{ type: "text" as const, text }],
      ui: buildOrderInquiryUi(buildOrderStub(orderId)),
      isError: true,
    };
  }

  const requiredPhrase = requiredPhraseFor(orderId);
  const confirmationKey = orderId;
  const now = Date.now();
  const existing = pendingConfirmations[confirmationKey];

  if (existing && existing.expiresAt < now) {
    delete pendingConfirmations[confirmationKey];
  }

  if (!confirmationId || !typedPhrase) {
    if (!order.canCancel) {
      const text = describeCancelFailure(orderId, {
        success: false,
        reason: "NOT_CANCELLABLE",
        status: order.status,
      });
      return {
        structuredContent: toStructured({
          orderId,
          success: false,
          reason: "NOT_CANCELLABLE",
          status: order.status,
          order,
        }),
        content: [{ type: "text" as const, text }],
        ui: buildOrderInquiryUi(order),
        isError: true,
      };
    }

    const expiresAtMs = now + CONFIRMATION_TTL_MS;
    pendingConfirmations[confirmationKey] = { orderId, expiresAt: expiresAtMs };
    const expiresAt = new Date(expiresAtMs).toISOString();
    const text = `Confirm cancellation by typing "${requiredPhrase}" before proceeding.`;
    return {
      structuredContent: toStructured({
        orderId,
        requiresConfirmation: true,
        confirmationId: confirmationKey,
        confirmationExpiresAt: expiresAt,
        requiredPhrase,
        reason: "CONFIRMATION_REQUIRED",
        order,
      }),
      content: [{ type: "text" as const, text }],
      ui: buildCancelConfirmUi(order, confirmationKey, expiresAt, requiredPhrase),
    };
  }

  if (confirmationId !== confirmationKey) {
    const text = "Confirmation ID does not match this order.";
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "INVALID_CONFIRMATION",
        status: order.status,
      }),
      content: [{ type: "text" as const, text }],
      ui: buildCancelConfirmUi(
        order,
        confirmationKey,
        new Date(now + CONFIRMATION_TTL_MS).toISOString(),
        requiredPhrase,
        text
      ),
      isError: true,
    };
  }

  const confirmation = pendingConfirmations[confirmationKey];
  if (!confirmation || confirmation.expiresAt < now) {
    const text = "Cancellation confirmation expired. Start again to cancel.";
    if (confirmation) {
      delete pendingConfirmations[confirmationKey];
    }
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "CONFIRMATION_EXPIRED",
        status: order.status,
      }),
      content: [{ type: "text" as const, text }],
      ui: buildCancelConfirmUi(
        order,
        confirmationKey,
        new Date(now + CONFIRMATION_TTL_MS).toISOString(),
        requiredPhrase,
        text
      ),
      isError: true,
    };
  }

  if (typedPhrase !== requiredPhrase) {
    const text = `Type the exact phrase "${requiredPhrase}" to confirm cancellation.`;
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "INVALID_PHRASE",
        status: order.status,
        requiredPhrase,
      }),
      content: [{ type: "text" as const, text }],
      ui: buildCancelConfirmUi(
        order,
        confirmationKey,
        new Date(confirmation.expiresAt).toISOString(),
        requiredPhrase,
        text
      ),
      isError: true,
    };
  }

  const result = await cancelOrder(orderId);
  delete pendingConfirmations[confirmationKey];
  const updatedOrder = (await getOrderStatus(orderId)) ?? order;

  const structuredContent = toStructured({ orderId, ...result, order: updatedOrder });
  const text = result.success
    ? describeCancelled(orderId, result)
    : describeCancelFailure(orderId, result);

  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
    ui: buildOrderInquiryUi(updatedOrder),
    isError: !result.success,
  };
};

const summarizeOrder = (order: Order): string => {
  const parts = [
    `Order ${order.orderId} is ${order.status}.`,
    order.placedAt ? `Placed: ${formatDateTime(order.placedAt) ?? order.placedAt}.` : "",
    order.customerName ? `Customer: ${order.customerName}.` : "",
    order.shippingMethod ? `Shipping: ${order.shippingMethod}.` : "",
    order.shippingAddress
      ? `Ship to ${order.shippingAddress.city}, ${order.shippingAddress.state}.`
      : "",
    order.eta ? `ETA: ${order.eta}.` : "",
    order.carrier ? `Carrier: ${order.carrier}.` : "",
    order.trackingNumber ? `Tracking: ${order.trackingNumber}.` : "",
    order.payment?.method
      ? `Payment: ${order.payment.method}${
          order.payment.last4 ? ` ending in ${order.payment.last4}` : ""
        }.`
      : "",
    order.totals?.total != null
      ? `Total: ${formatCurrency(order.totals.total, order.totals.currency)}.`
      : "",
    order.items?.length ? `Items: ${itemCount(order)}.` : "",
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

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith(WIDGET_ASSET_ROUTE)) {
    const served = await serveWidgetAsset(url.pathname, res);
    if (served) {
      return;
    }
  }

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
  console.log("[MCP] tool output template:", TOOL_OUTPUT_TEMPLATE_META);
});
