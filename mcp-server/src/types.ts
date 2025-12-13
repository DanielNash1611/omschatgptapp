export interface Order {
  orderId: string;
  customerName: string;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  eta: string | null;
  canCancel: boolean;
}

export type CancelOrderFailureReason = "ORDER_NOT_FOUND" | "NOT_CANCELLABLE";

export interface CancelOrderResult {
  success: boolean;
  status?: string;
  reason?: CancelOrderFailureReason;
}
