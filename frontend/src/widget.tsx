import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "./widget.css";

declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      setWidgetState?: (state: unknown) => void;
      actions?: {
        callTool?: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
      };
      callTool?: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    };
  }
}

type OrderItem = {
  id?: string;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  subtotal?: number;
  imageUrl?: string;
};

type ShippingAddress = {
  line1?: string;
  line2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type PaymentSummary = {
  method?: string | null;
  last4?: string | null;
};

type OrderTotals = {
  subtotal?: number;
  shipping?: number;
  tax?: number;
  total?: number;
  currency?: string;
};

type Order = {
  orderId: string;
  status: string;
  customerName: string;
  carrier: string | null;
  trackingNumber: string | null;
  eta: string | null;
  canCancel: boolean;
  placedAt?: string | null;
  shippingMethod?: string | null;
  shippingAddress?: ShippingAddress | null;
  payment?: PaymentSummary | null;
  totals?: OrderTotals | null;
  items?: OrderItem[];
  cancelledAt?: string | null;
};

type CancelConfirmProps = {
  order: Order;
  orderSummary?: {
    orderId?: string;
    status?: string;
    total?: number | null;
    currency?: string;
    itemCount?: number;
  };
  confirmationId: string;
  requiredPhrase: string;
  expiresAt?: string;
  warning?: string;
  errorMessage?: string;
};

type ToolUi =
  | { type: "order_inquiry_card"; props: { order: Order } }
  | { type: "cancel_confirm"; props: CancelConfirmProps };

const formatCurrency = (amount?: number, currency = "USD"): string | null => {
  if (typeof amount !== "number") return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
};

const formatDateTime = (value?: string | null): string | null => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
};

const lineSubtotal = (item: OrderItem): number | null => {
  if (typeof item.subtotal === "number") return item.subtotal;
  if (typeof item.quantity === "number" && typeof item.unitPrice === "number") {
    return item.quantity * item.unitPrice;
  }
  return null;
};

const getItemCount = (items?: OrderItem[] | null): number =>
  items?.reduce((sum, item) => sum + (item.quantity ?? 0), 0) ?? 0;

const normalizeOrder = (value?: Partial<Order>): Order => ({
  orderId: value?.orderId ?? "Unknown",
  status: value?.status ?? "UNKNOWN",
  customerName: value?.customerName ?? "Unknown",
  carrier: value?.carrier ?? null,
  trackingNumber: value?.trackingNumber ?? null,
  eta: value?.eta ?? null,
  canCancel: value?.canCancel ?? false,
  placedAt: value?.placedAt ?? null,
  shippingMethod: value?.shippingMethod ?? null,
  shippingAddress: value?.shippingAddress ?? null,
  payment: value?.payment ?? null,
  totals: value?.totals ?? null,
  items: value?.items ?? [],
  cancelledAt: value?.cancelledAt ?? null,
});

const pickUi = (source?: Record<string, unknown> | null): ToolUi | null => {
  if (!source) return null;
  const uiCandidate = source.ui;
  if (uiCandidate && typeof uiCandidate === "object" && "type" in (uiCandidate as Record<string, unknown>)) {
    const typed = uiCandidate as { type?: string; props?: Record<string, unknown> };
    if (typed.type === "order_inquiry_card" && typed.props?.order) {
      return { type: "order_inquiry_card", props: { order: normalizeOrder(typed.props.order as Partial<Order>) } };
    }
    if (typed.type === "cancel_confirm" && typed.props) {
      const props = typed.props as CancelConfirmProps;
      const normalizedOrder = normalizeOrder(props.order);
      return {
        type: "cancel_confirm",
        props: {
          ...props,
          order: normalizedOrder,
          confirmationId: props.confirmationId ?? normalizedOrder.orderId,
          requiredPhrase: props.requiredPhrase ?? `CANCEL ${normalizedOrder.orderId}`,
        },
      };
    }
  }

  if (source.requiresConfirmation && source.confirmationId) {
    const maybeOrder = "order" in source ? (source.order as Partial<Order>) : undefined;
    return {
      type: "cancel_confirm",
      props: {
        order: normalizeOrder(maybeOrder),
        confirmationId: String(source.confirmationId),
        requiredPhrase:
          typeof source.requiredPhrase === "string"
            ? source.requiredPhrase
            : `CANCEL ${(maybeOrder?.orderId ?? source.confirmationId) as string}`,
        expiresAt: typeof source.confirmationExpiresAt === "string" ? source.confirmationExpiresAt : undefined,
        warning: typeof source.warning === "string" ? source.warning : undefined,
        errorMessage: typeof source.errorMessage === "string" ? source.errorMessage : undefined,
      },
    };
  }

  const orderLike = source.order ?? source;
  if (orderLike && typeof orderLike === "object" && "orderId" in (orderLike as Record<string, unknown>)) {
    return { type: "order_inquiry_card", props: { order: normalizeOrder(orderLike as Partial<Order>) } };
  }

  return null;
};

const deriveUi = (raw: unknown): ToolUi | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const resultCandidate =
    pickUi(record) ||
    pickUi((record.result as Record<string, unknown>) ?? null) ||
    pickUi((record.structuredContent as Record<string, unknown>) ?? null);

  if (resultCandidate) return resultCandidate;

  const contentOrder =
    (record.order as Record<string, unknown>) ??
    (record.content as Record<string, unknown>) ??
    (record.result as Record<string, unknown>);
  if (contentOrder && "orderId" in contentOrder) {
    return { type: "order_inquiry_card", props: { order: normalizeOrder(contentOrder as Partial<Order>) } };
  }

  return null;
};

function OrderInquiryCard({ order }: { order: Order }) {
  const [showItems, setShowItems] = useState(false);
  const totals = order.totals;
  const items = order.items ?? [];
  const currency = totals?.currency ?? "USD";
  const count = getItemCount(items);

  return (
    <div className="card order-card">
      <div className="order-card__header">
        <div>
          <p className="eyebrow">Order summary</p>
          <h2 className="order-title">#{order.orderId}</h2>
          <p className="muted">
            {order.placedAt ? `Placed ${formatDateTime(order.placedAt)}` : "Order date unavailable"}
          </p>
        </div>
        <span className={`status-badge status-${order.status.toLowerCase()}`}>{order.status}</span>
      </div>

      <div className="order-grid">
        <div>
          <h3 className="section-title">Customer</h3>
          <p className="value">{order.customerName || "Unknown"}</p>
          {order.payment ? (
            <p className="muted">
              {order.payment.method ?? "Payment method unknown"}
              {order.payment.last4 ? ` ending in ${order.payment.last4}` : ""}
            </p>
          ) : (
            <p className="muted">Payment not provided</p>
          )}
        </div>

        <div>
          <h3 className="section-title">Shipping</h3>
          <p className="value">{order.shippingMethod ?? "Not set"}</p>
          {order.shippingAddress ? (
            <p className="muted">
              {order.shippingAddress.line1}
              {order.shippingAddress.line2 ? (
                <>
                  <br />
                  {order.shippingAddress.line2}
                </>
              ) : null}
              <br />
              {order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}
            </p>
          ) : (
            <p className="muted">Shipping address unavailable</p>
          )}
          {order.eta ? <p className="muted">ETA: {order.eta}</p> : null}
        </div>

        <div>
          <h3 className="section-title">Totals</h3>
          <p className="value">{formatCurrency(totals?.total, currency) ?? "—"}</p>
          <p className="muted">
            Subtotal {formatCurrency(totals?.subtotal, currency) ?? "—"}
            <br />
            Shipping {formatCurrency(totals?.shipping, currency) ?? "—"}
            <br />
            Tax {formatCurrency(totals?.tax, currency) ?? "—"}
          </p>
        </div>
      </div>

      <div className="items-section">
        <button className="items-toggle" onClick={() => setShowItems(prev => !prev)} aria-expanded={showItems}>
          Items ({count}) <span className="chevron">{showItems ? "\u25B2" : "\u25BC"}</span>
        </button>
        {showItems ? (
          <div className="items-list">
            {items.length === 0 ? (
              <p className="muted">No items found for this order.</p>
            ) : (
              items.map((item, index) => {
                const subtotal = lineSubtotal(item);
                const key = item.id ?? `${item.name ?? "item"}-${index}`;
                return (
                  <div className="item-row" key={key}>
                    <div className="item-thumb">
                      <img
                        src={
                          item.imageUrl ??
                          "https://placehold.co/80x80?text=Item"
                        }
                        alt={item.name ?? "Order item"}
                      />
                    </div>
                    <div className="item-details">
                      <p className="item-name">{item.name ?? "Unknown item"}</p>
                      <p className="muted">
                        Qty {item.quantity ?? "?"} @ {formatCurrency(item.unitPrice, currency) ?? "n/a"}
                      </p>
                    </div>
                    <div className="item-price">
                      {subtotal != null ? formatCurrency(subtotal, currency) : "—"}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>

      <div className="order-footnote">
        <span className="muted">
          {order.carrier && order.trackingNumber
            ? `Tracking: ${order.carrier} ${order.trackingNumber}`
            : "Tracking not available"}
        </span>
        <span className="muted">{order.canCancel ? "Cancellable" : "Not cancellable"}</span>
      </div>
    </div>
  );
}

function CancelConfirmCard({
  order,
  orderSummary,
  confirmationId,
  requiredPhrase,
  expiresAt,
  warning,
  errorMessage,
  onConfirm,
  onDeny,
}: CancelConfirmProps & { onConfirm: (typedPhrase: string) => Promise<void>; onDeny: () => void }) {
  const [typed, setTyped] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const disableConfirm = typed !== requiredPhrase || isSubmitting;
  const expiresLabel = expiresAt ? formatDateTime(expiresAt) : null;
  const summaryTotal =
    orderSummary?.total != null
      ? formatCurrency(orderSummary.total, orderSummary.currency ?? "USD")
      : formatCurrency(order.totals?.total, order.totals?.currency ?? "USD");
  const summaryItems = orderSummary?.itemCount ?? getItemCount(order.items);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setLocalError(null);
    try {
      await onConfirm(typed);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to run cancellation.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="card confirm-card">
      <div className="order-card__header">
        <div>
          <p className="eyebrow">Cancellation</p>
          <h2 className="order-title">Confirm order {order.orderId}</h2>
          <p className="muted">
            Status: {order.status}
            {summaryTotal ? ` • Total ${summaryTotal}` : ""}
            {summaryItems ? ` • ${summaryItems} items` : ""}
          </p>
        </div>
        <span className={`status-badge status-${order.status.toLowerCase()}`}>{order.status}</span>
      </div>

      <div className="warning">
        <strong>Heads up:</strong> {warning ?? "Cancellation cannot be undone once confirmed."}
        <span className="muted">Confirmation ID: {confirmationId}</span>
        {expiresLabel ? <span className="muted">Expires {expiresLabel}</span> : null}
      </div>

      <div className="confirm-fields">
        <label className="section-title" htmlFor="confirm-input">
          Type the phrase to confirm
        </label>
        <input
          id="confirm-input"
          type="text"
          value={typed}
          onChange={event => setTyped(event.target.value)}
          placeholder={requiredPhrase}
        />
        <p className="muted">Required phrase: {requiredPhrase}</p>
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {localError ? <p className="error-text">{localError}</p> : null}

      <div className="confirm-actions">
        <button type="button" className="ghost" onClick={onDeny} disabled={isSubmitting}>
          No, keep order
        </button>
        <button type="button" onClick={handleConfirm} disabled={disableConfirm}>
          {isSubmitting ? "Submitting..." : "Yes, cancel this order"}
        </button>
      </div>
    </div>
  );
}

function Widget() {
  const [latest, setLatest] = useState<unknown>(() => window.openai?.toolOutput ?? null);

  useEffect(() => {
    window.openai?.setWidgetState?.(latest);
  }, [latest]);

  const ui = useMemo(() => deriveUi(latest), [latest]);

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
    await callTool("order_cancel", {
      orderId: payload.order.orderId,
      confirmationId: payload.confirmationId,
      typedPhrase,
    });
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

      {!ui && (
        <div className="card">
          <p>No OMS tool output yet. Run order inquiry or cancellation.</p>
        </div>
      )}

      {ui?.type === "order_inquiry_card" && <OrderInquiryCard order={ui.props.order} />}
      {ui?.type === "cancel_confirm" && (
        <CancelConfirmCard
          {...ui.props}
          onConfirm={typed => handleConfirm(typed, ui.props)}
          onDeny={() => handleDeny(ui.props)}
        />
      )}
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
