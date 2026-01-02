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
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID ?? randomUUID().slice(0, 8);
const LOG_PREFIX = `[MCP:${INSTANCE_ID}]`;
const UI_RESOURCE_URI = "ui://widget/oms-order-v2.html";
const WIDGET_MIME_TYPE = "text/html+skybridge";
const DEFAULT_WIDGET_ORIGIN = "https://omschatgptapp.vercel.app";
const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");
const parseCommaSeparatedEnv = (value?: string): string[] =>
  (value ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
const WIDGET_ORIGIN = normalizeOrigin(
  process.env.OMS_WIDGET_ORIGIN ?? DEFAULT_WIDGET_ORIGIN
);
const WIDGET_JS_URL =
  process.env.OMS_WIDGET_JS_URL ?? `${WIDGET_ORIGIN}/widget/widget.js`;
const WIDGET_CSS_URL =
  process.env.OMS_WIDGET_CSS_URL ?? `${WIDGET_ORIGIN}/widget/widget.css`;
const WIDGET_RESOURCE_DOMAIN_EXTRAS = parseCommaSeparatedEnv(
  process.env.OMS_WIDGET_RESOURCE_DOMAINS
);
const WIDGET_RESOURCE_DOMAINS = Array.from(
  new Set([WIDGET_ORIGIN, "https://images.unsplash.com", ...WIDGET_RESOURCE_DOMAIN_EXTRAS])
);
const WIDGET_CONNECT_DOMAINS = parseCommaSeparatedEnv(
  process.env.OMS_WIDGET_CONNECT_DOMAINS
);
const WIDGET_DESCRIPTION =
  "OMS order summary + cancellation confirmation widget";

type OpenAIToolMeta = {
  "openai/outputTemplate"?: string;
  "openai/widgetAccessible"?: boolean;
  "openai/widgetCSP"?: unknown;
};

const TOOL_DEBUG_META = {} satisfies OpenAIToolMeta;
const TOOL_OUTPUT_TEMPLATE_META = {
  "openai/outputTemplate": UI_RESOURCE_URI,
} satisfies OpenAIToolMeta;
const TOOL_WIDGET_ACCESS_META = {
  "openai/widgetAccessible": true,
} satisfies OpenAIToolMeta;
const TOOL_OUTPUT_AND_ACCESS_META = {
  ...TOOL_OUTPUT_TEMPLATE_META,
  ...TOOL_WIDGET_ACCESS_META,
} satisfies OpenAIToolMeta;
const TOOL_DEBUG_INFO = [
  {
    name: "get_order_status",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "get_order_status_v2",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "order_inquiry",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "cancel_order",
    meta: TOOL_OUTPUT_AND_ACCESS_META,
  },
  {
    name: "cancel_order_v2",
    meta: TOOL_OUTPUT_AND_ACCESS_META,
  },
  {
    name: "order_cancel",
    meta: TOOL_OUTPUT_AND_ACCESS_META,
  },
  {
    name: "confirm_cancel_order",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "confirm_cancel_order_v2",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "debug_list_tools",
    meta: TOOL_DEBUG_META,
  },
  {
    name: "debug_list_tools_meta",
    meta: TOOL_DEBUG_META,
  },
] as const satisfies ReadonlyArray<{ name: string; meta: OpenAIToolMeta }>;

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
const confirmCancelSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  typedPhrase: z.string().min(1, "typedPhrase is required"),
});

const pendingConfirmations: Record<string, { orderId: string; expiresAt: number }> = {};

type WidgetHtmlResult = {
  html: string;
  bytes: number;
};

const logInfo = (...args: unknown[]) => {
  console.log(LOG_PREFIX, ...args);
};

const logWarn = (...args: unknown[]) => {
  console.warn(LOG_PREFIX, ...args);
};

const logError = (...args: unknown[]) => {
  console.error(LOG_PREFIX, ...args);
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.stack ?? error.message : String(error);


const buildWidgetHtml = (): WidgetHtmlResult => {
  const cssTag = WIDGET_CSS_URL
    ? `<link rel="stylesheet" href="${WIDGET_CSS_URL}" />`
    : "";
  const jsTag = WIDGET_JS_URL
    ? `<script type="module" src="${WIDGET_JS_URL}"></script>`
    : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OMS Widget</title>
    ${cssTag}
  </head>
  <body>
    <div id="oms-root"></div>
    ${jsTag}
  </body>
</html>`;
  return { html, bytes: Buffer.byteLength(html) };
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
      logInfo("UI resource requested:", UI_RESOURCE_URI);
      const result = await buildWidgetHtml();
      logInfo("UI resource bytes:", result.bytes);
      return {
        contents: [
          {
            uri: UI_RESOURCE_URI,
            mimeType: WIDGET_MIME_TYPE,
            text: result.html,
            _meta: {
              "openai/widgetPrefersBorder": true,
              "openai/widgetDescription": WIDGET_DESCRIPTION,
              "openai/widgetDomain": WIDGET_ORIGIN,
              "openai/widgetCSP": {
                connect_domains: WIDGET_CONNECT_DOMAINS,
                resource_domains: WIDGET_RESOURCE_DOMAINS,
              },
            },
          },
        ],
      };
    }
  );
};


const createServer = () => {
  const server = new McpServer({
    name: "oms-mcp-server",
    version: "0.1.0",
  });

  registerWidgetResource(server);
  logInfo("widget resource registered:", UI_RESOURCE_URI, WIDGET_MIME_TYPE);

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
    "get_order_status_v2",
    {
      title: "Get order status v2",
      description: "Look up the status and details for an OMS order (v2).",
      inputSchema: orderIdSchema,
      _meta: TOOL_OUTPUT_TEMPLATE_META,
    },
    async ({ orderId }) => withToolVersion(await handleOrderInquiry(orderId), "v2")
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
      _meta: TOOL_OUTPUT_AND_ACCESS_META,
    },
    async ({ orderId, confirmationId, typedPhrase }) =>
      handleOrderCancel({ orderId })
  );
  server.registerTool(
    "cancel_order_v2",
    {
      title: "Cancel order v2",
      description: "Request or confirm an OMS order cancellation (v2).",
      inputSchema: cancelOrderSchema,
      _meta: TOOL_OUTPUT_AND_ACCESS_META,
    },
    async ({ orderId, confirmationId, typedPhrase }) =>
      withToolVersion(await handleOrderCancel({ orderId, confirmationId, typedPhrase }), "v2")
  );
  server.registerTool(
    "order_cancel",
    {
      title: "Order cancel",
      description: "Alias for cancel_order.",
      inputSchema: cancelOrderSchema,
      _meta: TOOL_OUTPUT_AND_ACCESS_META,
    },
    async ({ orderId, confirmationId, typedPhrase }) =>
      handleOrderCancel({ orderId, confirmationId, typedPhrase })
  );

  server.registerTool(
    "confirm_cancel_order",
    {
      title: "Confirm cancel order",
      description: "Finalize a pending OMS order cancellation after phrase confirmation.",
      inputSchema: confirmCancelSchema,
      _meta: TOOL_OUTPUT_TEMPLATE_META,
    },
    async ({ orderId, typedPhrase }) => handleConfirmCancelOrder({ orderId, typedPhrase })
  );
  server.registerTool(
    "confirm_cancel_order_v2",
    {
      title: "Confirm cancel order v2",
      description: "Finalize a pending OMS order cancellation after phrase confirmation (v2).",
      inputSchema: confirmCancelSchema,
      _meta: TOOL_OUTPUT_TEMPLATE_META,
    },
    async ({ orderId, typedPhrase }) =>
      withToolVersion(await handleConfirmCancelOrder({ orderId, typedPhrase }), "v2")
  );

  server.registerTool(
    "debug_list_tools",
    {
      title: "Debug list tools",
      description: "Return tool metadata for widget rendering diagnostics.",
    },
    async () => handleDebugListTools()
  );
  server.registerTool(
    "debug_list_tools_meta",
    {
      title: "Debug list tools meta",
      description: "Return tool metadata used for widget rendering diagnostics.",
      inputSchema: z.object({}),
    },
    async () => handleDebugListTools()
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

const buildOrderSummary = (order: Order): Record<string, unknown> => ({
  orderId: order.orderId,
  status: order.status,
  canCancel: order.canCancel,
  eta: order.eta,
  carrier: order.carrier,
  trackingNumber: order.trackingNumber,
  placedAt: order.placedAt ?? null,
  shippingMethod: order.shippingMethod ?? null,
  totals: order.totals
    ? {
        total: order.totals.total ?? null,
        currency: order.totals.currency ?? "USD",
      }
    : null,
  itemCount: itemCount(order),
  cancelledAt: order.cancelledAt ?? null,
});

const withToolVersion = (result: CallToolResult, toolVersion: string): CallToolResult => ({
  ...result,
  structuredContent: {
    ...(result.structuredContent ?? {}),
    toolVersion,
  },
});

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

type ConfirmCancelArgs = {
  orderId: string;
  typedPhrase: string;
};

const handleDebugListTools = (): CallToolResult => {
  const tools = TOOL_DEBUG_INFO.map(tool => {
    const meta: OpenAIToolMeta = tool.meta;
    return {
      name: tool.name,
      outputTemplate: meta["openai/outputTemplate"] ?? null,
      widgetAccessible: meta["openai/widgetAccessible"] ?? false,
    };
  });
  return {
    structuredContent: toStructured({ tools }),
    content: [{ type: "text" as const, text: "Tool metadata listed." }],
  };
};

const handleConfirmCancelOrder = async ({
  orderId,
  typedPhrase,
}: ConfirmCancelArgs): Promise<CallToolResult> => {
  const order = await getOrderStatus(orderId);
  if (!order) {
    const text = `Order ${orderId} was not found; nothing was cancelled.`;
    const stub = buildOrderStub(orderId);
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "ORDER_NOT_FOUND",
      }),
      content: [{ type: "text" as const, text }],
      _meta: { order: stub },
      ui: buildOrderInquiryUi(stub),
      isError: true,
    };
  }

  const requiredPhrase = requiredPhraseFor(orderId);
  const confirmation = pendingConfirmations[orderId];
  const now = Date.now();

  if (!confirmation || confirmation.expiresAt < now) {
    const text = "Cancellation confirmation expired. Start again to cancel.";
    if (confirmation) {
      delete pendingConfirmations[orderId];
    }
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "CONFIRMATION_EXPIRED",
        status: order.status,
      }),
      content: [{ type: "text" as const, text }],
      _meta: { order },
      ui: buildCancelConfirmUi(
        order,
        orderId,
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
      _meta: { order },
      ui: buildCancelConfirmUi(
        order,
        orderId,
        new Date(confirmation.expiresAt).toISOString(),
        requiredPhrase,
        text
      ),
      isError: true,
    };
  }

  const result = await cancelOrder(orderId);
  delete pendingConfirmations[orderId];
  const updatedOrder = (await getOrderStatus(orderId)) ?? order;
  const text = result.success
    ? `Order ${orderId} has been cancelled.`
    : describeCancelFailure(orderId, result);

  return {
    structuredContent: toStructured({
      orderId,
      success: result.success,
      status: updatedOrder.status,
      cancelledAt: result.cancelledAt,
      order: buildOrderSummary(updatedOrder),
    }),
    content: [{ type: "text" as const, text }],
    _meta: { order: updatedOrder },
    ui: buildOrderInquiryUi(updatedOrder),
    isError: !result.success,
  };
};

const handleOrderInquiry = async (orderId: string): Promise<CallToolResult> => {
  const order = await getOrderStatus(orderId);

  if (!order) {
    const text = `Order ${orderId} was not found in the OMS.`;
    const stub = buildOrderStub(orderId);
    return {
      structuredContent: toStructured({
        orderId,
        status: "NOT_FOUND",
      }),
      content: [{ type: "text" as const, text }],
      _meta: { order: stub },
      ui: buildOrderInquiryUi(stub),
      isError: true,
    };
  }

  return {
    structuredContent: toStructured({ order: buildOrderSummary(order) }),
    content: [{ type: "text" as const, text: summarizeOrder(order) }],
    _meta: { order },
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
    const stub = buildOrderStub(orderId);
    return {
      structuredContent: toStructured({
        orderId,
        success: false,
        reason: "ORDER_NOT_FOUND",
      }),
      content: [{ type: "text" as const, text }],
      _meta: { order: stub },
      ui: buildOrderInquiryUi(stub),
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
          order: buildOrderSummary(order),
        }),
        content: [{ type: "text" as const, text }],
        _meta: { order },
        ui: buildOrderInquiryUi(order),
        isError: true,
      };
    }

    const expiresAtMs = now + CONFIRMATION_TTL_MS;
    pendingConfirmations[confirmationKey] = { orderId, expiresAt: expiresAtMs };
    const expiresAt = new Date(expiresAtMs).toISOString();
    const text = `Reply with "${requiredPhrase}" to confirm cancellation.`;
    return {
      structuredContent: toStructured({
        orderId,
        requiresConfirmation: true,
        confirmationId: confirmationKey,
        confirmationExpiresAt: expiresAt,
        requiredPhrase,
        reason: "CONFIRMATION_REQUIRED",
        order: buildOrderSummary(order),
      }),
      content: [{ type: "text" as const, text }],
      _meta: { order },
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
      _meta: { order },
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
      _meta: { order },
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
      _meta: { order },
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

  const structuredContent = toStructured({
    orderId,
    success: result.success,
    status: updatedOrder.status,
    reason: result.reason,
    cancelledAt: result.cancelledAt,
    order: buildOrderSummary(updatedOrder),
  });
  const text = result.success
    ? describeCancelled(orderId, result)
    : describeCancelFailure(orderId, result);

  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
    _meta: { order: updatedOrder },
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
    logError("MCP server connection error:", formatError(error));
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  logInfo(`OMS MCP server listening on http://${HOST}:${PORT}${PATH}`);
  logInfo("tool output template:", TOOL_OUTPUT_TEMPLATE_META);
  logInfo("widget origin:", WIDGET_ORIGIN);
  logInfo("widget js:", WIDGET_JS_URL);
  logInfo("widget css:", WIDGET_CSS_URL);
});
