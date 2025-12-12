// Quickstart:
// 1. cd backend
// 2. npm install
// 3. Create a .env file with OPENAI_API_KEY=your_key_here
// 4. npm run dev
// 5. Backend listens on http://localhost:3001

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { callAssistant } from "./openaiClient";
import { cancelOrder, getOrderStatus } from "./omsClient";
import { SYSTEM_PROMPT } from "./prompts";
import { Order } from "./types";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: "http://localhost:5173"
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/tools/get_order_status", async (req, res) => {
  const orderId = typeof req.body?.orderId === "string" ? req.body.orderId.trim() : "";

  if (!orderId) {
    return res.status(400).json({ error: "orderId is required" });
  }

  const rpcPayload = {
    jsonrpc: "2.0" as const,
    id: "backend-bridge",
    method: "tools.call",
    params: {
      name: "get_order_status",
      arguments: { orderId }
    }
  };

  try {
    const mcpResponse = await fetch("http://localhost:3002/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcPayload)
    });

    if (!mcpResponse.ok) {
      return res
        .status(502)
        .json({ error: "Failed to reach OMS tool bridge", status: mcpResponse.status });
    }

    const rpcJson = await mcpResponse.json();

    if (rpcJson?.error) {
      return res
        .status(500)
        .json({ error: "MCP tool error", details: rpcJson.error });
    }

    const content = rpcJson?.result?.content ?? {};

    const clean: Order = {
      orderId: content.orderId ?? orderId,
      status: content.status ?? "UNKNOWN",
      eta: content.eta ?? null,
      carrier: content.carrier ?? null,
      trackingNumber: content.trackingNumber ?? null,
      canCancel: content.canCancel ?? false,
      customerName: content.customerName ?? "Unknown"
    };

    return res.json(clean);
  } catch (error: unknown) {
    console.error("Error in /api/tools/get_order_status:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: String(error)
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const userMessage: string | undefined = req.body?.message;

  if (!userMessage || typeof userMessage !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];

  try {
    const firstResponse = await callAssistant(messages);
    const firstMessage = firstResponse.choices[0]?.message;

    if (firstMessage?.tool_calls && firstMessage.tool_calls.length > 0) {
      messages.push(firstMessage as ChatCompletionMessageParam);

      const toolCall = firstMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      let parsedArgs: Record<string, string> = {};

      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }

      let toolResult: unknown = null;
      let debugAction: string | undefined;
      let debugOrderId: string | undefined;

      if (functionName === "get_order_status") {
        debugAction = "get_order_status";
        debugOrderId = parsedArgs.orderId;
        toolResult = parsedArgs.orderId
          ? await getOrderStatus(parsedArgs.orderId)
          : { error: "orderId missing" };
      } else if (functionName === "cancel_order") {
        debugAction = "cancel_order";
        debugOrderId = parsedArgs.orderId;
        toolResult = parsedArgs.orderId
          ? await cancelOrder(parsedArgs.orderId)
          : { error: "orderId missing" };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult)
      });

      const secondResponse = await callAssistant(messages);
      const finalMessage = secondResponse.choices[0]?.message;
      let finalText = "";
      if (typeof finalMessage?.content === "string") {
        finalText = finalMessage.content;
      } else if (Array.isArray(finalMessage?.content)) {
        const parts: unknown[] = finalMessage.content;
        finalText = parts
          .map((chunk: unknown): string => {
            if (typeof chunk === "string") return chunk;
            if (chunk && typeof chunk === "object" && "text" in (chunk as { text?: string })) {
              const maybeText = (chunk as { text?: string }).text;
              if (typeof maybeText === "string") return maybeText;
            }
            return (chunk as { toString?: () => string })?.toString?.() ?? "";
          })
          .join("");
      }

      return res.json({
        assistantMessage: finalText,
        debug: {
          action: debugAction,
          orderId: debugOrderId,
          toolResult
        }
      });
    }

    const assistantText =
      typeof firstMessage?.content === "string"
        ? firstMessage.content
        : "I didn't get that. Can you rephrase?";

    return res.json({ assistantMessage: assistantText });
  } catch (error: unknown) {
    console.error("Error in /api/chat:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`OMS assistant backend listening on http://localhost:${PORT}`);
});
