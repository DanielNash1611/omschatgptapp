import { useState } from "react";
import "./omsToolUi.css";

export type OrderItem = {
  id?: string;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  subtotal?: number;
  imageUrl?: string;
};

export type ShippingAddress = {
  line1?: string;
  line2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export type PaymentSummary = {
  method?: string | null;
  last4?: string | null;
};

export type OrderTotals = {
  subtotal?: number;
  shipping?: number;
  tax?: number;
  total?: number;
  currency?: string;
};

export type Order = {
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

export type OrderMeta = {
  source?: string;
  reason?: string;
  requestId?: string;
  originalOrderId?: string;
};

export type CancelConfirmProps = {
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

export type OmsToolUi =
  | { type: "order_inquiry_card"; props: { order: Order; meta?: OrderMeta } }
  | { type: "cancel_confirm"; props: CancelConfirmProps };

type OmsToolUiCardProps = {
  ui: OmsToolUi;
  onConfirmCancel?: (typedPhrase: string, payload: CancelConfirmProps) => Promise<void>;
  onDenyCancel?: (payload: CancelConfirmProps) => void;
};

type OmsToolResponseCardProps = {
  value: unknown;
  emptyState?: string;
  onConfirmCancel?: (typedPhrase: string, payload: CancelConfirmProps) => Promise<void>;
  onDenyCancel?: (payload: CancelConfirmProps) => void;
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getObjectKeys = (value: unknown): string[] =>
  isRecord(value) ? Object.keys(value) : [];

export const normalizeOrder = (value?: Partial<Order>): Order => ({
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

export const mergeToolState = (output: unknown, metadata: unknown): unknown => {
  if (!isRecord(output) && !isRecord(metadata)) {
    return output ?? metadata ?? null;
  }
  return {
    ...(isRecord(output) ? output : {}),
    ...(isRecord(metadata) ? metadata : {}),
  };
};

export const normalizeToolResponse = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const structured = isRecord(value.structuredContent) ? value.structuredContent : null;
  const meta = isRecord(value._meta) ? value._meta : null;
  if (structured || meta) {
    return mergeToolState(structured ?? value, meta ?? null);
  }
  return value;
};

const pickUi = (source?: Record<string, unknown> | null): OmsToolUi | null => {
  if (!source) return null;

  const uiCandidate = source.ui;
  if (uiCandidate && typeof uiCandidate === "object" && "type" in (uiCandidate as Record<string, unknown>)) {
    const typed = uiCandidate as { type?: string; props?: Record<string, unknown> };
    if (typed.type === "order_inquiry_card" && typed.props?.order) {
      return {
        type: "order_inquiry_card",
        props: {
          order: normalizeOrder(typed.props.order as Partial<Order>),
          meta: typed.props.meta as OrderMeta | undefined,
        },
      };
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
  const meta =
    (source.meta as OrderMeta | undefined) ??
    (source.structuredContent as { meta?: OrderMeta } | undefined)?.meta ??
    undefined;

  if (orderLike && typeof orderLike === "object" && "orderId" in (orderLike as Record<string, unknown>)) {
    return {
      type: "order_inquiry_card",
      props: { order: normalizeOrder(orderLike as Partial<Order>), meta },
    };
  }

  return null;
};

export const deriveOmsToolUi = (raw: unknown): OmsToolUi | null => {
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
    return {
      type: "order_inquiry_card",
      props: { order: normalizeOrder(contentOrder as Partial<Order>) },
    };
  }

  return null;
};

function OrderInquiryCard({ order, meta }: { order: Order; meta?: OrderMeta }) {
  const [showItems, setShowItems] = useState(false);
  const totals = order.totals;
  const items = order.items ?? [];
  const currency = totals?.currency ?? "USD";
  const count = getItemCount(items);

  return (
    <div className="card order-card">
      {meta?.source === "mock_fallback" ? (
        <div className="mock-banner">
          Mock fallback used ({meta.reason ?? "unknown reason"}).
        </div>
      ) : null}

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
              {[order.shippingAddress.city, [order.shippingAddress.state, order.shippingAddress.postalCode].filter(Boolean).join(" ")]
                .filter(Boolean)
                .join(", ")}
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
                        src={item.imageUrl ?? "https://placehold.co/80x80?text=Item"}
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
  onConfirmCancel,
  onDenyCancel,
}: CancelConfirmProps & {
  onConfirmCancel?: (typedPhrase: string, payload: CancelConfirmProps) => Promise<void>;
  onDenyCancel?: (payload: CancelConfirmProps) => void;
}) {
  const [typed, setTyped] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canInteract = Boolean(onConfirmCancel && onDenyCancel);
  const disableConfirm = typed !== requiredPhrase || isSubmitting || !canInteract;
  const expiresLabel = expiresAt ? formatDateTime(expiresAt) : null;
  const summaryTotal =
    orderSummary?.total != null
      ? formatCurrency(orderSummary.total, orderSummary.currency ?? "USD")
      : formatCurrency(order.totals?.total, order.totals?.currency ?? "USD");
  const summaryItems = orderSummary?.itemCount ?? getItemCount(order.items);

  const payload: CancelConfirmProps = {
    order,
    orderSummary,
    confirmationId,
    requiredPhrase,
    expiresAt,
    warning,
    errorMessage,
  };

  const handleConfirm = async () => {
    if (!onConfirmCancel) {
      setLocalError("Cancellation confirmation is not available in this view.");
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    try {
      await onConfirmCancel(typed, payload);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to run cancellation.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeny = () => {
    if (!onDenyCancel) {
      setLocalError("Cancellation confirmation is not available in this view.");
      return;
    }
    setLocalError(null);
    onDenyCancel(payload);
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
        <label className="section-title" htmlFor={`confirm-input-${confirmationId}`}>
          Type the phrase to confirm
        </label>
        <input
          id={`confirm-input-${confirmationId}`}
          type="text"
          value={typed}
          onChange={event => setTyped(event.target.value)}
          placeholder={requiredPhrase}
        />
        <p className="muted">Required phrase: {requiredPhrase}</p>
        {!canInteract ? (
          <p className="muted">Interactive confirmation is only available in tool-enabled views.</p>
        ) : null}
      </div>

      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      {localError ? <p className="error-text">{localError}</p> : null}

      <div className="confirm-actions">
        <button type="button" className="ghost" onClick={handleDeny} disabled={isSubmitting || !canInteract}>
          No, keep order
        </button>
        <button type="button" onClick={handleConfirm} disabled={disableConfirm}>
          {isSubmitting ? "Submitting..." : "Yes, cancel this order"}
        </button>
      </div>
    </div>
  );
}

export function OmsToolUiCard({
  ui,
  onConfirmCancel,
  onDenyCancel,
}: OmsToolUiCardProps) {
  return (
    <div className="oms-tool-ui">
      {ui.type === "order_inquiry_card" ? (
        <OrderInquiryCard order={ui.props.order} meta={ui.props.meta} />
      ) : (
        <CancelConfirmCard
          {...ui.props}
          onConfirmCancel={onConfirmCancel}
          onDenyCancel={onDenyCancel}
        />
      )}
    </div>
  );
}

export function OmsToolResponseCard({
  value,
  emptyState,
  onConfirmCancel,
  onDenyCancel,
}: OmsToolResponseCardProps) {
  const ui = deriveOmsToolUi(value);

  if (!ui) {
    if (!emptyState) return null;

    return (
      <div className="oms-tool-ui">
        <div className="card">
          <p>{emptyState}</p>
        </div>
      </div>
    );
  }

  return (
    <OmsToolUiCard
      ui={ui}
      onConfirmCancel={onConfirmCancel}
      onDenyCancel={onDenyCancel}
    />
  );
}
