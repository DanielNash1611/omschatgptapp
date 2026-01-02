# OMS ChatGPT Mock Assistant

Small, two-tier TypeScript prototype that wires a ChatGPT-style UI to mock OMS tools for order lookup and cancellation. Swap the mock OMS client for your real APIs when ready.

## Backend
- Location: `backend`
- Stack: Express + TypeScript + OpenAI SDK (tool calls)
- Quickstart: `cd backend && npm install && echo "OPENAI_API_KEY=your_key" > .env && npm run dev`
- API: POST `http://localhost:3001/api/chat` with `{ "message": "Where is order 1002?" }`

## Frontend
- Location: `frontend`
- Stack: React + TypeScript + Vite
- Quickstart: `cd frontend && npm install && npm run dev` then open `http://localhost:5173`
- The UI posts chat messages to `http://localhost:3001/api/chat`

## Shared OMS logic
- Core mock OMS functions live in `shared/oms.ts` (types in `shared/types.ts`)
- Backend re-exports via `backend/src/omsClient.ts` so `/api/chat` keeps working
- Replace mock logic in `shared/oms.ts` with real OMS API calls once ready

## MCP server
- Location: `mcp-server`
- Stack: TypeScript + `@modelcontextprotocol/sdk`
- Tools: `get_order_status(orderId: string)`, `cancel_order(orderId: string, confirmationId?: string, typedPhrase?: string)`
- Widget template URI: `ui://widget/oms-order-v2.html` (served from `frontend/dist` via MCP resource + `http://localhost:8787/widget-assets/`)
- Quickstart: `cd mcp-server && npm install && npm run dev` (defaults to port 8787)

## Widget (ChatGPT App UI bundle)
- Location: `frontend/src/widget.tsx` (entry) with `frontend/widget.html`
- Built/served by the same Vite project; dev URL `http://localhost:5173/widget.html`
- Widget expects `window.openai.toolOutput` (provided by ChatGPT Apps) and renders order/cancel results

## Replace mocks with real OMS
- Implement real order lookup/cancel logic in `shared/oms.ts`
- Keep payloads aligned with the shared shapes in `shared/types.ts`
- System prompt + tool definitions live in `backend/src/prompts.ts`
