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
const TOOL_DEBUG_INFO = [
  {
    name: "get_order_status",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "order_inquiry",
    meta: TOOL_OUTPUT_TEMPLATE_META,
  },
  {
    name: "cancel_order",
    meta: TOOL_WIDGET_TEMPLATE_META,
  },
  {
    name: "order_cancel",
    meta: TOOL_WIDGET_TEMPLATE_META,
  },
] as const;
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

type ParsedWidgetAssets = {
  cssFiles: string[];
  jsFiles: string[];
};

const parseWidgetAssets = (html: string): ParsedWidgetAssets => {
  const cssFiles: string[] = [];
  const jsFiles: string[] = [];
  const seen = new Set<string>();
  const regex = /(?:src|href)=["']\/assets\/([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const asset = match[1];
    if (seen.has(asset)) continue;
    seen.add(asset);
    if (asset.endsWith(".css")) {
      cssFiles.push(asset);
    } else if (asset.endsWith(".js")) {
      jsFiles.push(asset);
    }
  }
  return { cssFiles, jsFiles };
};

const parseImportSpecifiers = (spec: string) =>
  spec
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const [exportName, localName] = item.split(/\s+as\s+/);
      return {
        exportName: exportName.trim(),
        localName: (localName ?? exportName).trim(),
      };
    });

const buildWidgetHtml = async (): Promise<WidgetHtmlResult> => {
  try {
    let rawHtml: string;
    try {
      rawHtml = await readFile(WIDGET_HTML_PATH, "utf-8");
    } catch (error) {
      console.error("[MCP] widget html read failed", {
        path: WIDGET_HTML_PATH,
        error: String(error),
      });
      throw error;
    }
    console.log("[MCP] widget html read:", WIDGET_HTML_PATH, rawHtml.length);
    const { cssFiles, jsFiles } = parseWidgetAssets(rawHtml);
    if (cssFiles.length === 0 && jsFiles.length === 0) {
      throw new Error("widget.html did not reference any assets.");
    }

    if (jsFiles.length === 0) {
      throw new Error("No widget JS bundle found in dist assets.");
    }

    const cssContents = await Promise.all(
      cssFiles.map(async name => {
        try {
          return await readFile(resolve(WIDGET_ASSET_DIR, name), "utf-8");
        } catch (error) {
          console.error("[MCP] widget css read failed", { file: name, error: String(error) });
          throw error;
        }
      })
    );
    const jsContents = await Promise.all(
      jsFiles.map(async name => {
        try {
          return await readFile(resolve(WIDGET_ASSET_DIR, name), "utf-8");
        } catch (error) {
          console.error("[MCP] widget js read failed", { file: name, error: String(error) });
          throw error;
        }
      })
    );

    const styleBlocks = cssContents.map(css => `<style>${css}</style>`).join("\n");
    const jsMap = new Map<string, string>();
    jsFiles.forEach((name, index) => {
      jsMap.set(name, jsContents[index]);
    });
    const clientFile = jsFiles.find(name => name.startsWith("client-"));
    const widgetFile = jsFiles.find(name => name.startsWith("widget-")) ?? jsFiles[0];
    const clientExports: string[] = [];

    if (clientFile) {
      const widgetCode = jsMap.get(widgetFile) ?? "";
      const importRegex = new RegExp(
        `import\\s*\\{([^}]+)\\}\\s*from["']\\./${clientFile}["'];?`
      );
      const match = widgetCode.match(importRegex);
      if (match) {
        const specifiers = parseImportSpecifiers(match[1]);
        specifiers.forEach(spec => {
          if (!clientExports.includes(spec.exportName)) {
            clientExports.push(spec.exportName);
          }
        });
        const destructured = specifiers
          .map(spec =>
            spec.exportName === spec.localName
              ? spec.exportName
              : `${spec.exportName}: ${spec.localName}`
          )
          .join(", ");
        const replacement = `const { ${destructured} } = globalThis.__omsWidgetClient || {};`;
        jsMap.set(widgetFile, widgetCode.replace(importRegex, replacement));
      }
    }

    const orderedJsFiles = clientFile
      ? [clientFile, ...jsFiles.filter(name => name !== clientFile)]
      : [...jsFiles];
    const combinedJs = orderedJsFiles
      .map(name => {
        const code = jsMap.get(name) ?? "";
        if (name === clientFile && clientExports.length > 0) {
          return `${code}\n;globalThis.__omsWidgetClient = { ${clientExports.join(", ")} };`;
        }
        return code;
      })
      .join("\n");
    const scriptBlocks = `<script type="module">${combinedJs}</script>`;

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OMS Widget</title>
  </head>
  <body>
    <div id="root"></div>
    <div id="oms-widget-marker" style="display:none">OMS Widget Loaded</div>
    ${styleBlocks}
    ${scriptBlocks}
  </body>
</html>`;

    return { html, source: "dist", bytes: Buffer.byteLength(html) };
  } catch (error) {
    console.error("[MCP] widget build unavailable", {
      path: WIDGET_ASSET_DIR,
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
    <div>Widget build missing: run npm run build in frontend.</div>
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
      console.log("[MCP] UI resource requested:", UI_RESOURCE_URI);
      const result = await buildWidgetHtml();
      console.log("[MCP] widget template bytes:", result.bytes);
      return {
        contents: [
          {
            uri: UI_RESOURCE_URI,
            mimeType: WIDGET_MIME_TYPE,
            text: result.html,
            _meta: { "openai/widgetPrefersBorder": true },
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
  console.log("[MCP] widget asset requested:", pathname);
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

  server.registerTool(
    "debug_list_tools",
    {
      title: "Debug list tools",
      description: "Return tool metadata for widget rendering diagnostics.",
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

const handleDebugListTools = (): CallToolResult => {
  const tools = TOOL_DEBUG_INFO.map(tool => ({
    name: tool.name,
    outputTemplate: tool.meta["openai/outputTemplate"] ?? null,
    widgetAccessible: tool.meta["openai/widgetAccessible"] ?? false,
  }));
  return {
    structuredContent: toStructured({ tools }),
    content: [{ type: "text" as const, text: "Tool metadata listed." }],
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
    const text = `Confirm cancellation by typing "${requiredPhrase}" before proceeding.`;
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
