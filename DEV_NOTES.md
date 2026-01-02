# OMS ChatGPT App Prototype – widget + cancel flow notes

## Where UI wiring lives
- Widget entry: `frontend/src/widget.tsx`
- Styles: `frontend/src/widget.css`
- MCP tools that emit UI descriptors: `mcp-server/src/server.ts`
- Mock OMS data (orders/items): `shared/oms.ts` (mirrored in `backend/src/omsClient.ts` and `mcp-server/src/oms.ts`)

## Tool output shape expected by the widget
- Include a top-level `ui` field on tool results: `{ ui: { type: "order_inquiry_card", props: { order } } }`
- Inquiry tools: `get_order_status` and `order_inquiry` both return that shape.
- Cancel tool: `order_cancel`/`cancel_order` return `{ requiresConfirmation, confirmationId, requiredPhrase, ui: { type: "cancel_confirm", props: {...}} }` on step 1; after confirmation they return the updated order card UI.

## Debugging tips
- In dev builds, the widget logs the raw tool output and the resolved UI to the console (`[oms-widget]` prefix).
- If no UI renders, confirm the tool response includes `ui.type` and `ui.props` (or `structuredContent.ui`).
- Widget bundle is served at `widget.html` (dev) and registered in README as `ui://widget/oms.html`.

## Testing the cancel guardrail
1) Call `order_cancel` without `confirmationId`/`typedPhrase` → confirmation UI appears (not cancelled).
2) Type the exact phrase `CANCEL <orderId>` and submit → order transitions to Cancelled and renders the inquiry card.
3) Use “No, keep order” to dismiss and return to the inquiry card without cancelling.
