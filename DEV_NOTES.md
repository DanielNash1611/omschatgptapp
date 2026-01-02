# OMS ChatGPT App Prototype – widget + cancel flow notes

## Where UI wiring lives
- Widget entry: `frontend/src/widget.tsx`
- Styles: `frontend/src/widget.css`
- MCP tools that emit UI descriptors: `mcp-server/src/server.ts`
- Mock OMS data (orders/items): `shared/oms.ts` (mirrored in `backend/src/omsClient.ts` and `mcp-server/src/oms.ts`)

## Tool output shape expected by the widget
- Widget reads `window.openai.toolOutput` (structuredContent) and can merge `window.openai.toolResponseMetadata` when present.
- Tool responses include full order data in `structuredContent` plus a top-level `ui` field for local rendering.
- Cancel tool: `cancel_order` returns `{ requiresConfirmation, confirmationId, requiredPhrase }` on step 1; after confirmation it returns the updated order card data.

## Debugging tips
- In dev builds, the widget logs the raw tool output and the resolved UI to the console (`[oms-widget]` prefix).
- If no UI renders, confirm `toolOutput` includes `order` data or `requiresConfirmation`.
- Widget template resource is registered as `ui://widget/oms-order-v2.html`.
- Backend logs request IDs, auth diagnostics, and MCP bridge errors for `/api/tools/get_order_status` when dev diagnostics are enabled.

## Testing the cancel guardrail
1) Call `cancel_order` without `confirmationId`/`typedPhrase` -> confirmation UI appears (not cancelled).
2) Type the exact phrase `CANCEL <orderId>` and submit -> order transitions to Cancelled and renders the inquiry card.
3) Use "No, keep order" to dismiss and return to the inquiry card without cancelling.

## How to verify widget loads
1) Build the frontend (`cd frontend && npm run build`) so `frontend/dist` exists.
2) Start MCP server (`cd mcp-server && npm run dev`).
3) Call `get_order_status` for order 1002 and confirm the widget renders instead of plain tool text.
4) The Skybridge HTML inlines JS/CSS from `frontend/dist/assets` (no external asset fetch required).

## Where to see logs
- MCP server stdout shows widget resource requests and asset path lookups (`[MCP]` prefix).

## Mock fallback behavior
- If `get_order_status` fails due to auth or MCP connectivity in dev, the tool bridge can return order 1002 marked as mock.
- Enable explicitly in production with `OMS_PROTOTYPE_ALLOW_MOCK_FALLBACK=true`.

## Diagnostics environment flags
- `OMS_PROTOTYPE_DEV_DIAGNOSTICS=true` to enable verbose logs.
- `OMS_MCP_URL=http://localhost:8787/mcp` to point the tool bridge at a custom MCP endpoint.
- `OMS_TOOL_REQUIRE_AUTH=true`, `OMS_TOOL_AUTH_MODE=bearer`, `OMS_TOOL_AUTH_HEADER=authorization` to simulate auth enforcement.
