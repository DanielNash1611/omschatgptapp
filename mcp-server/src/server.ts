import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
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
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID ?? randomUUID().slice(0, 8);
const LOG_PREFIX = `[MCP:${INSTANCE_ID}]`;
const UI_RESOURCE_URI = "ui://widget/oms-order-v2.html";
const WIDGET_MIME_TYPE = "text/html+skybridge";
const WIDGET_ASSET_ROUTE = "/widget-assets/";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET_HTML_CANDIDATES = ["widget.html", "index.html"];
const PACKAGED_WIDGET_DIR = resolve(SERVER_ROOT, "widget-dist");
const FALLBACK_WIDGET_DIR = resolve(REPO_ROOT, "frontend", "dist");
const DEFAULT_WIDGET_DOMAIN = "https://web-sandbox.oaiusercontent.com";
const WIDGET_DOMAIN = process.env.OMS_WIDGET_DOMAIN ?? DEFAULT_WIDGET_DOMAIN;
const WIDGET_RESOURCE_DOMAINS = [
  WIDGET_DOMAIN,
  "https://images.unsplash.com",
];
const parseCommaSeparatedEnv = (value?: string): string[] =>
  (value ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
const WIDGET_CONNECT_DOMAINS = parseCommaSeparatedEnv(
  process.env.OMS_WIDGET_CONNECT_DOMAINS
);
const WIDGET_DESCRIPTION = "OMS order status and cancellation widget.";

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
const confirmCancelSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  typedPhrase: z.string().min(1, "typedPhrase is required"),
});

const pendingConfirmations: Record<string, { orderId: string; expiresAt: number }> = {};

type WidgetHtmlResult = {
  html: string;
  source: "dist" | "fallback";
  bytes: number;
};

type WidgetPaths = {
  baseDir: string;
  assetsDir: string;
  htmlCandidates: Array<{ name: string; path: string }>;
  source: "packaged" | "fallback";
};

type WidgetPathStatus = {
  htmlPath: string | null;
  htmlStatus: Record<string, boolean>;
  assetsExists: boolean;
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

const buildWidgetPaths = (baseDir: string, source: WidgetPaths["source"]): WidgetPaths => ({
  baseDir,
  assetsDir: resolve(baseDir, "assets"),
  htmlCandidates: WIDGET_HTML_CANDIDATES.map(name => ({
    name,
    path: resolve(baseDir, name),
  })),
  source,
});

const PRIMARY_WIDGET_PATHS = buildWidgetPaths(PACKAGED_WIDGET_DIR, "packaged");
const FALLBACK_WIDGET_PATHS = buildWidgetPaths(FALLBACK_WIDGET_DIR, "fallback");

const checkPathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const checkWidgetPaths = async (paths: WidgetPaths): Promise<WidgetPathStatus> => {
  const assetsExists = await checkPathExists(paths.assetsDir);
  const htmlChecks = await Promise.all(
    paths.htmlCandidates.map(async candidate => ({
      name: candidate.name,
      path: candidate.path,
      exists: await checkPathExists(candidate.path),
    }))
  );
  const htmlStatus: Record<string, boolean> = {};
  let htmlPath: string | null = null;
  htmlChecks.forEach(result => {
    htmlStatus[result.name] = result.exists;
    if (!htmlPath && result.exists) {
      htmlPath = result.path;
    }
  });
  return { htmlPath, htmlStatus, assetsExists };
};

const selectWidgetPaths = async () => {
  const primaryStatus = await checkWidgetPaths(PRIMARY_WIDGET_PATHS);
  if (primaryStatus.htmlPath && primaryStatus.assetsExists) {
    return { paths: PRIMARY_WIDGET_PATHS, status: primaryStatus };
  }
  const fallbackStatus = await checkWidgetPaths(FALLBACK_WIDGET_PATHS);
  if (fallbackStatus.htmlPath && fallbackStatus.assetsExists) {
    return { paths: FALLBACK_WIDGET_PATHS, status: fallbackStatus };
  }
  return { paths: PRIMARY_WIDGET_PATHS, status: primaryStatus };
};

const logWidgetArtifactStatus = async (): Promise<void> => {
  logInfo("widget paths", {
    packaged: PRIMARY_WIDGET_PATHS,
    fallback: FALLBACK_WIDGET_PATHS,
  });
  const [primaryStatus, fallbackStatus] = await Promise.all([
    checkWidgetPaths(PRIMARY_WIDGET_PATHS),
    checkWidgetPaths(FALLBACK_WIDGET_PATHS),
  ]);
  logInfo("widget paths status", {
    packaged: primaryStatus,
    fallback: fallbackStatus,
  });
  const selected = await selectWidgetPaths();
  const selectedName =
    selected.paths.htmlCandidates.find(candidate => candidate.path === selected.status.htmlPath)
      ?.name ?? null;
  logInfo("widget paths selected", {
    source: selected.paths.source,
    baseDir: selected.paths.baseDir,
    html: selectedName,
  });
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

const listDirectory = async (dir: string): Promise<string[] | null> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return null;
  }
};

const buildWidgetHtml = async (): Promise<WidgetHtmlResult> => {
  let selection: Awaited<ReturnType<typeof selectWidgetPaths>> | null = null;
  try {
    selection = await selectWidgetPaths();
    const widgetPaths = selection.paths;
    const selectedHtmlPath = selection.status.htmlPath;
    const selectedHtmlName =
      widgetPaths.htmlCandidates.find(candidate => candidate.path === selectedHtmlPath)?.name ??
      null;
    logInfo("widget assets source", widgetPaths.source, widgetPaths.baseDir);
    logInfo("widget html selected", {
      name: selectedHtmlName,
      path: selectedHtmlPath,
    });
    if (!selectedHtmlPath) {
      throw new Error("No widget HTML file found (widget.html or index.html).");
    }
    let rawHtml: string;
    try {
      rawHtml = await readFile(selectedHtmlPath, "utf-8");
    } catch (error) {
      logError("widget html read failed", {
        path: selectedHtmlPath,
        error: formatError(error),
      });
      throw error;
    }
    logInfo("widget html read:", selectedHtmlPath, rawHtml.length);
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
          return await readFile(resolve(widgetPaths.assetsDir, name), "utf-8");
        } catch (error) {
          logError("widget css read failed", { file: name, error: formatError(error) });
          throw error;
        }
      })
    );
    const jsContents = await Promise.all(
      jsFiles.map(async name => {
        try {
          return await readFile(resolve(widgetPaths.assetsDir, name), "utf-8");
        } catch (error) {
          logError("widget js read failed", { file: name, error: formatError(error) });
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

    return {
      html,
      source: widgetPaths.source === "packaged" ? "dist" : "fallback",
      bytes: Buffer.byteLength(html),
    };
  } catch (error) {
    const [primaryStatus, fallbackStatus, packagedListing, fallbackListing] = await Promise.all([
      checkWidgetPaths(PRIMARY_WIDGET_PATHS),
      checkWidgetPaths(FALLBACK_WIDGET_PATHS),
      listDirectory(PRIMARY_WIDGET_PATHS.baseDir),
      listDirectory(FALLBACK_WIDGET_PATHS.baseDir),
    ]);
    const selectedHtml = selection?.status.htmlPath ?? null;
    const selectedName =
      selection?.paths.htmlCandidates.find(candidate => candidate.path === selectedHtml)?.name ??
      null;
    const hasAnyHtml =
      Object.values(primaryStatus.htmlStatus).some(Boolean) ||
      Object.values(fallbackStatus.htmlStatus).some(Boolean);
    const fallbackDetails = {
      candidates: WIDGET_HTML_CANDIDATES,
      selected: {
        source: selection?.paths.source ?? null,
        html: selectedName,
      },
      packaged: {
        baseDir: PRIMARY_WIDGET_PATHS.baseDir,
        assetsDir: PRIMARY_WIDGET_PATHS.assetsDir,
        htmlStatus: primaryStatus.htmlStatus,
      },
      fallback: {
        baseDir: FALLBACK_WIDGET_PATHS.baseDir,
        assetsDir: FALLBACK_WIDGET_PATHS.assetsDir,
        htmlStatus: fallbackStatus.htmlStatus,
      },
      listings: {
        packaged: packagedListing,
        fallback: fallbackListing,
      },
    };
    logError("widget build unavailable", {
      error: formatError(error),
      details: fallbackDetails,
    });
    const headline = hasAnyHtml
      ? "Widget build incomplete: check widget assets."
      : "Widget build missing: run npm run build at the repo root.";
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OMS Widget</title>
  </head>
  <body>
    <div>${headline}</div>
    <pre>${JSON.stringify(fallbackDetails, null, 2)}</pre>
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
              "openai/widgetDomain": WIDGET_DOMAIN,
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

const resolveWidgetAssetPath = async (pathname: string): Promise<string | null> => {
  if (!pathname.startsWith(WIDGET_ASSET_ROUTE)) return null;
  const relative = pathname.slice(WIDGET_ASSET_ROUTE.length);
  if (!relative) return null;
  const safeRelative = normalize(relative).replace(/^(\.\.[\\/])+/, "");
  const assetDirs = [PRIMARY_WIDGET_PATHS.assetsDir, FALLBACK_WIDGET_PATHS.assetsDir];
  for (const baseDir of assetDirs) {
    const fullPath = resolve(baseDir, safeRelative);
    if (!fullPath.startsWith(baseDir)) continue;
    if (await checkPathExists(fullPath)) {
      return fullPath;
    }
  }
  return null;
};

const serveWidgetAsset = async (
  pathname: string,
  res: ServerResponse
): Promise<boolean> => {
  logInfo("widget asset requested:", pathname);
  const assetPath = await resolveWidgetAssetPath(pathname);
  if (!assetPath) {
    logWarn("widget asset invalid path:", pathname);
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
    logInfo("widget asset served:", pathname, data.length);
  } catch (error) {
    logWarn("widget asset 404:", pathname);
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

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith(WIDGET_ASSET_ROUTE)) {
    logInfo("widget asset requested:", req.url ?? url.pathname);
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
    logError("MCP server connection error:", formatError(error));
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  logInfo(`OMS MCP server listening on http://${HOST}:${PORT}${PATH}`);
  logInfo("tool output template:", TOOL_OUTPUT_TEMPLATE_META);
  void logWidgetArtifactStatus();
});
