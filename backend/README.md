# Backend

Express + TypeScript server for the OMS assistant and tools bridge.

## Quickstart
1. `cd backend`
2. `npm install`
3. Set `OPENAI_API_KEY` in `.env` (for `/api/chat`)
4. `npm run dev` (listens on http://localhost:3001)

## Endpoints
- `POST /api/chat` — existing ChatGPT-style assistant (OpenAI + tool calls)
- `POST /api/tools/get_order_status` — OMS tools bridge for ChatGPT Actions
  - Body: `{ "orderId": "1002" }`
  - Proxies to the MCP-like server at `http://localhost:3002/mcp`
  - Returns order fields: `orderId`, `status`, `eta`, `carrier`, `trackingNumber`, `canCancel`, `customerName`

## Notes
- The `/api/tools/get_order_status` endpoint depends on the MCP-like JSON-RPC server running at `PORT=3002` (`mcp-server` project).
- OpenAPI spec for the tools bridge: `backend/openapi-oms-tools.json`.
