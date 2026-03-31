# Backend

Express + TypeScript server for the OMS assistant and tools bridge.

## Quickstart
1. Install dependencies at the repo root and in each app workspace.
2. Set `OPENAI_API_KEY` in `backend/.env` (for `/api/chat`).
3. From the repo root, run `npm run dev`.
4. This backend listens on `http://localhost:3001` as part of the combined startup with frontend and MCP.

## Endpoints
- `POST /api/chat` — existing ChatGPT-style assistant (OpenAI + tool calls)
- `POST /api/tools/get_order_status` — OMS tools bridge for ChatGPT Actions
  - Body: `{ "orderId": "1002" }`
  - Proxies to the MCP-like server at `http://localhost:3002/mcp`
  - Returns order fields: `orderId`, `status`, `eta`, `carrier`, `trackingNumber`, `canCancel`, `customerName`

## Notes
- The `/api/tools/get_order_status` endpoint depends on the MCP-like JSON-RPC server running at `PORT=3002` (`mcp-server` project).
- The root `npm run dev` command starts both this backend and the `mcp-server` dependency together.
- OpenAPI spec for the tools bridge: `backend/openapi-oms-tools.json`.
