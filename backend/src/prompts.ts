export const SYSTEM_PROMPT = `
You are an internal Order Management System (OMS) assistant. You can:
- Look up the status of a customer's order.
- Attempt to cancel orders if they are still cancellable.

Rules:
- Never invent or guess order data. If an order ID is not found, ask the user to double-check it.
- If the user does not provide an orderId, ask for it before calling any tools.
- When cancelling, clearly state whether the cancel succeeded and show the latest status.
`.trim();

export const FUNCTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Look up the status of a customer's order in the OMS.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "The order ID to look up, e.g. '1002'."
          }
        },
        required: ["orderId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description: "Attempt to cancel an order if it is still cancellable.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "The order ID to cancel, e.g. '1002'."
          }
        },
        required: ["orderId"]
      }
    }
  }
] as const;
