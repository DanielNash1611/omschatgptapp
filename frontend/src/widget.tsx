import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "./widget.css";

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      setWidgetState?: (state: unknown) => void;
    };
  }
}

type OrderLike = {
  orderId?: string;
  status?: string;
  eta?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  customerName?: string;
  canCancel?: boolean;
};

type CancelResultLike = {
  success?: boolean;
  status?: string;
  reason?: string;
};

function deriveDisplayData(toolOutput: unknown) {
  if (!toolOutput || typeof toolOutput !== "object") return null;
  if ("orderId" in (toolOutput as OrderLike)) {
    return { type: "order" as const, payload: toolOutput as OrderLike };
  }
  if ("success" in (toolOutput as CancelResultLike)) {
    return { type: "cancel" as const, payload: toolOutput as CancelResultLike };
  }
  return null;
}

function Widget() {
  const [latest, _setLatest] = useState<unknown>(() => window.openai?.toolOutput);

  useEffect(() => {
    // Persist the last seen output so the widget can rehydrate if reopened.
    window.openai?.setWidgetState?.(latest);
  }, [latest]);

  const display = useMemo(() => deriveDisplayData(latest), [latest]);

  const renderOrder = (order: OrderLike) => {
    return (
      <div className="card">
        <h2>Order {order.orderId ?? "Unknown"}</h2>
        <p className="status">Status: {order.status ?? "n/a"}</p>
        {order.eta && <p>ETA: {order.eta}</p>}
        {order.carrier && order.trackingNumber && (
          <p>
            Tracking: {order.carrier} {order.trackingNumber}
          </p>
        )}
        <p>Customer: {order.customerName ?? "n/a"}</p>
        <p>Cancellable: {order.canCancel ? "Yes" : "No"}</p>
      </div>
    );
  };

  const renderCancel = (result: CancelResultLike) => {
    return (
      <div className="card">
        <h2>Cancel order</h2>
        <p className="status">
          {result.success
            ? "Cancellation succeeded"
            : `Unable to cancel (${result.reason ?? "Unknown"})`}
        </p>
        {result.status && <p>Current status: {result.status}</p>}
      </div>
    );
  };

  return (
    <div className="widget">
      <header>
        <p className="eyebrow">OMS Widget</p>
        <h1>Order helper</h1>
        <p className="lede">
          Displays the latest OMS tool output from this conversation.
        </p>
      </header>

      {!display && (
        <div className="card">
          <p>No OMS tool output yet. Run get_order_status or cancel_order.</p>
        </div>
      )}

      {display?.type === "order" && renderOrder(display.payload)}
      {display?.type === "cancel" && renderCancel(display.payload)}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <Widget />
    </React.StrictMode>
  );
}
