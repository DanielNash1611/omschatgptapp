## OMS MCP-like JSON-RPC Server (No SDK)

Minimal MCP-style server implemented with Node HTTP + TypeScript (no `@modelcontextprotocol/sdk` dependency) to expose OMS tools for local testing or as a scaffold for a future MCP server.

### Quickstart
1) Install dependencies at the repo root and in each app workspace.
2) From the repo root, run `npm run dev`.
3) This server listens on `http://localhost:3002/mcp` as part of the combined startup with backend and frontend.

### Endpoint
- `POST http://localhost:3002/mcp`
- Request shape (JSON-RPC 2.0 subset):
  ```json
  {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tools.call",
    "params": {
      "name": "get_order_status",
      "arguments": { "orderId": "1002" }
    }
  }
  ```

### Tools exposed
- `get_order_status`
  - Input: `{ orderId: string }`
  - Output: `{ name, content: { orderId, status, eta?, carrier?, trackingNumber?, history: [] } }`
- Example request:
  ```json
  {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tools.call",
    "params": { "name": "get_order_status", "arguments": { "orderId": "1002" } }
  }
  ```
- Example response (mock):
  ```json
  {
    "jsonrpc": "2.0",
    "id": "1",
    "result": {
      "name": "get_order_status",
      "content": {
        "orderId": "1002",
        "status": "Processing",
        "eta": "2025-01-10",
        "carrier": null,
        "trackingNumber": null,
        "history": []
      }
    }
  }
  ```
- `cancel_order`
  - Input: `{ orderId: string }`
  - Output: `{ name, content: { orderId, success, status?, reason?, cancelledAt? } }`
- Example request:
  ```json
  {
    "jsonrpc": "2.0",
    "id": "2",
    "method": "tools.call",
    "params": { "name": "cancel_order", "arguments": { "orderId": "1002" } }
  }
  ```
- Example response (mock, success):
  ```json
  {
    "jsonrpc": "2.0",
    "id": "2",
    "result": {
      "name": "cancel_order",
      "content": {
        "orderId": "1002",
        "success": true,
        "status": "Cancelled",
        "cancelledAt": "2025-01-01T00:00:00.000Z"
      }
    }
  }
  ```

### Error shape
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": -32000,
    "message": "Tool not found"
  }
}
```

### Shared OMS logic
- Uses `shared/oms.ts` and `shared/types.ts` for mock data and shapes.
- Replace the mock implementations in `shared/oms.ts` with real OMS API calls when ready.
