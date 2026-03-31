import { useEffect, useMemo, useState } from "react";
import {
  CancelConfirmProps,
  deriveOmsToolUi,
  getObjectKeys,
  mergeToolState,
  normalizeToolResponse,
  OmsToolResponseCard,
} from "./omsToolUi";
import "./widget.css";

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      toolResponseMetadata?: unknown;
      setWidgetState?: (state: unknown) => void;
      actions?: {
        callTool?: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
      };
      callTool?: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    };
  }
}

const getHostToolState = (): unknown =>
  mergeToolState(window.openai?.toolOutput ?? null, window.openai?.toolResponseMetadata ?? null);

export function Widget() {
  const [latest, setLatest] = useState<unknown>(() => getHostToolState());

  useEffect(() => {
    window.openai?.setWidgetState?.(latest);
  }, [latest]);

  const ui = useMemo(() => deriveOmsToolUi(latest), [latest]);

  useEffect(() => {
    if (import.meta.env?.DEV) {
      console.debug("[oms-widget] toolOutput keys", getObjectKeys(window.openai?.toolOutput));
      console.debug(
        "[oms-widget] toolResponseMetadata keys",
        getObjectKeys(window.openai?.toolResponseMetadata)
      );
      console.debug("[oms-widget] latest tool output", latest);
      console.debug("[oms-widget] resolved ui", ui);
    }
  }, [latest, ui]);

  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (typeof window.openai?.actions?.callTool === "function") {
      return window.openai.actions.callTool({ name, arguments: args });
    }
    if (typeof window.openai?.callTool === "function") {
      return window.openai.callTool({ name, arguments: args });
    }
    throw new Error("Tool bridge is not available in this environment.");
  };

  const handleConfirm = async (typedPhrase: string, payload: CancelConfirmProps) => {
    const toolPayload = {
      orderId: payload.order.orderId,
      confirmationId: payload.confirmationId,
      typedPhrase,
    };

    if (import.meta.env?.DEV) {
      console.debug("[oms-widget] confirm tool payload", toolPayload);
    }

    const result = await callTool("cancel_order", toolPayload);
    if (result !== undefined) {
      setLatest(normalizeToolResponse(result));
    }
  };

  const handleDeny = (payload: CancelConfirmProps) => {
    setLatest({ ui: { type: "order_inquiry_card", props: { order: payload.order } } });
  };

  return (
    <div className="widget">
      <header>
        <p className="eyebrow">OMS Widget</p>
        <h1>Order helper</h1>
        <p className="lede">Displays the latest OMS tool output from this conversation.</p>
      </header>

      <OmsToolResponseCard
        value={latest}
        emptyState="No OMS tool output yet. Run order inquiry or cancellation."
        onConfirmCancel={handleConfirm}
        onDenyCancel={handleDeny}
      />
    </div>
  );
}
